import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RTCDataChannel } from "werift";
import * as sharedOfflineVerifierModule
  from "../../scripts/lib/gpu-hmr-runtime-evidence-transport-offline-verifier.mjs";
import {
  RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
  RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
  RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
  RuntimeEvidenceTransportChannelRouter,
  RuntimeEvidenceTransportKeyPin,
  RuntimeEvidenceTransportReceiptConsumer,
  SessionRuntimeEvidenceTransportReplayStore,
  type RuntimeEvidenceTransportSupportEnvelopeInput,
  type RuntimeEvidenceTransportVerificationContext,
  type RuntimeEvidenceTransportVerificationKey,
  parseRuntimeEvidenceTransportVerificationKey,
  verifyRuntimeEvidenceTransportSupportEnvelopeOffline,
} from "../../src/runtime_evidence_transport.js";

const verifySharedOffline = (
  sharedOfflineVerifierModule as unknown as Readonly<{
    verifyRuntimeEvidenceTransportSupportEnvelopeOffline:
      typeof verifyRuntimeEvidenceTransportSupportEnvelopeOffline;
  }>
).verifyRuntimeEvidenceTransportSupportEnvelopeOffline;

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

function parsedVerificationKey(
  announcement: Record<string, unknown>,
): RuntimeEvidenceTransportVerificationKey {
  const key = parseRuntimeEvidenceTransportVerificationKey(announcement);
  if (key === null) throw new Error("test verification key fixture is invalid");
  return key;
}

function verificationContext(
  input: RuntimeEvidenceTransportSupportEnvelopeInput,
): RuntimeEvidenceTransportVerificationContext {
  return {
    runnerProcessId: input.runnerProcessId,
    runtimeSessionId: input.runtimeSessionId,
    runnerChallenge: input.runnerChallenge,
    transportSessionId: input.transportSessionId,
    requestId: input.requestId,
    sourceEditId: input.sourceEditId,
    subjectIdentityNamespace: input.subjectIdentityNamespace,
    subjectCanonicalBytes: input.subjectCanonicalBytes,
    artifactContentHash: input.artifactContentHash,
    observedRuntimeProofId: input.observedRuntimeProofId,
    observedProofLedgerId: input.observedProofLedgerId,
  };
}

function crossRealmUint8Array(value: Uint8Array): Uint8Array {
  return runInNewContext(
    `new Uint8Array([${Array.from(value).join(",")}])`,
  ) as Uint8Array;
}

function installStatefulGetter(
  target: Record<string, unknown>,
  key: string,
  firstValue: unknown,
  laterValue: unknown,
): () => number {
  let reads = 0;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? firstValue : laterValue;
    },
  });
  return () => reads;
}

function verifyOffline(
  key: RuntimeEvidenceTransportVerificationKey,
  fixture: SignedEnvelopeFixture,
  overrides: {
    readonly observedPayload?: Uint8Array | string;
    readonly context?: RuntimeEvidenceTransportVerificationContext;
  } = {},
) {
  return verifyRuntimeEvidenceTransportSupportEnvelopeOffline(
    key,
    fixture.input.envelope,
    overrides.observedPayload ?? fixture.input.observedPayload,
    overrides.context ?? verificationContext(fixture.input),
  );
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

  describe("waitUntilPinned", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("resolves a pending wait once the key is pinned", async () => {
      vi.useFakeTimers();
      const channel = new MockDataChannel();
      const pin = new RuntimeEvidenceTransportKeyPin();
      pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
      const wait = pin.waitUntilPinned(1_000);
      expect(vi.getTimerCount()).toBe(1);

      const announcement = keyAnnouncement(21);
      channel.emit(JSON.stringify(announcement));

      const snapshot = await wait;
      expect(snapshot).toEqual({
        status: "pinned",
        key: announcement,
        failureReason: null,
      });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.key)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("resolves an already pinned snapshot without installing a timer", async () => {
      vi.useFakeTimers();
      const pin = pinAnnouncement(keyAnnouncement(22));

      const snapshot = await pin.waitUntilPinned(1_000);

      expect(snapshot.status).toBe("pinned");
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.key)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects a pending wait with the pin failure reason", async () => {
      vi.useFakeTimers();
      const channel = new MockDataChannel();
      const pin = new RuntimeEvidenceTransportKeyPin();
      pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
      const wait = pin.waitUntilPinned(1_000);
      const rejection = expect(wait).rejects.toThrow(
        "runtime_evidence_transport_key_announcement_json_invalid",
      );

      channel.emit("not-json");

      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects when disposal occurs before or prior to the wait", async () => {
      vi.useFakeTimers();
      const pendingPin = new RuntimeEvidenceTransportKeyPin();
      const pendingWait = pendingPin.waitUntilPinned(1_000);
      const pendingRejection = expect(pendingWait).rejects.toThrow(
        "runtime_evidence_transport_key_pin_disposed",
      );

      pendingPin.dispose();

      await pendingRejection;
      expect(vi.getTimerCount()).toBe(0);

      const disposedPin = new RuntimeEvidenceTransportKeyPin();
      disposedPin.dispose();
      await expect(disposedPin.waitUntilPinned(1_000)).rejects.toThrow(
        "runtime_evidence_transport_key_pin_disposed",
      );
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects invalid timeout values without subscribing or scheduling", async () => {
      vi.useFakeTimers();
      const pin = new RuntimeEvidenceTransportKeyPin();

      for (const timeoutMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
        await expect(pin.waitUntilPinned(timeoutMs)).rejects.toThrow(
          "runtime_evidence_transport_key_pin_wait_timeout_invalid",
        );
      }
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects when the bounded wait times out", async () => {
      vi.useFakeTimers();
      const pin = new RuntimeEvidenceTransportKeyPin();
      const wait = pin.waitUntilPinned(50);
      const rejection = expect(wait).rejects.toThrow(
        "runtime_evidence_transport_key_pin_wait_timeout",
      );
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(50);

      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    });

    it("unsubscribes its listener after the first settlement", async () => {
      vi.useFakeTimers();
      const channel = new MockDataChannel();
      const pin = new RuntimeEvidenceTransportKeyPin();
      pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
      const observedStatuses: string[] = [];
      const unsubscribeSpy = vi.fn();
      const onChange = pin.onChange.bind(pin);
      vi.spyOn(pin, "onChange").mockImplementation((listener) => {
        const unsubscribe = onChange((snapshot) => {
          observedStatuses.push(snapshot.status);
          listener(snapshot);
        });
        return () => {
          unsubscribeSpy();
          unsubscribe();
        };
      });
      const resolutionSpy = vi.fn();
      const wait = pin.waitUntilPinned(100).then(resolutionSpy);

      channel.emit(JSON.stringify(keyAnnouncement(23)));
      await wait;
      channel.emit(JSON.stringify(keyAnnouncement(24)));
      await vi.advanceTimersByTimeAsync(100);

      expect(observedStatuses).toEqual(["pending", "pinned"]);
      expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
      expect(resolutionSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
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

  it("rejects malformed UTF-8 bytes without replacement decoding", () => {
    const channel = new MockDataChannel();
    const removeListener = vi.spyOn(channel, "removeEventListener");
    const pin = new RuntimeEvidenceTransportKeyPin();
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    channel.emit(new Uint8Array([0xff]));

    expect(pin.snapshot()).toEqual({
      status: "failed",
      key: null,
      failureReason: "runtime_evidence_transport_key_announcement_encoding_invalid",
    });
    expect(removeListener).toHaveBeenCalledWith("message", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith("close", expect.any(Function));
    expect(removeListener).toHaveBeenCalledTimes(2);
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

describe("RuntimeEvidenceTransportChannelRouter", () => {
  it("routes a key then a recognized support envelope without changing the pinned key", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    const router = new RuntimeEvidenceTransportChannelRouter(pin);
    const delivered: string[] = [];
    router.onSupportEnvelope((serializedEnvelope) => delivered.push(serializedEnvelope));
    router.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    const identity = signingIdentity(41);
    const fixture = signedEnvelopeFixture(identity);
    const serializedEnvelope = JSON.stringify(fixture.input.envelope);

    channel.emit(JSON.stringify(identity.announcement));
    channel.emit(serializedEnvelope);

    expect(pin.snapshot()).toMatchObject({
      status: "pinned",
      key: identity.announcement,
      failureReason: null,
    });
    expect(router.snapshot()).toEqual({
      status: "active",
      failureReason: null,
      retainedSupportEnvelopeCount: 1,
      retainedSupportEnvelopeBytes: Buffer.byteLength(serializedEnvelope, "utf8"),
    });
    expect(delivered).toEqual([serializedEnvelope]);
    expect(router.drainSupportEnvelopes()).toEqual([serializedEnvelope]);
    expect(router.snapshot().retainedSupportEnvelopeCount).toBe(0);
  });

  it("fails malformed and unknown router messages without mutating an already pinned key", () => {
    for (const [message, reason] of [
      ["not-json", "runtime_evidence_transport_router_message_json_invalid"],
      [JSON.stringify({ schemaVersion: "synthi.gpu_hmr.unrecognized.v1" }),
        "runtime_evidence_transport_router_message_schema_unknown"],
      [JSON.stringify({ schemaVersion: "synthi.gpu_hmr.observed_runtime_evidence_envelope.v2" }),
        "runtime_evidence_transport_router_message_type_unknown"],
    ] as const) {
      const channel = new MockDataChannel();
      const pin = new RuntimeEvidenceTransportKeyPin();
      const router = new RuntimeEvidenceTransportChannelRouter(pin);
      router.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
      const announcement = keyAnnouncement(42);
      channel.emit(JSON.stringify(announcement));

      channel.emit(message);

      expect(router.snapshot()).toEqual({
        status: "failed",
        failureReason: reason,
        retainedSupportEnvelopeCount: 0,
        retainedSupportEnvelopeBytes: 0,
      });
      expect(pin.snapshot()).toEqual({
        status: "pinned",
        key: announcement,
        failureReason: null,
      });
    }
  });

  it("keeps duplicate keys idempotent and rejects a replacement through the key-only pin", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    const router = new RuntimeEvidenceTransportChannelRouter(pin);
    router.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    const first = keyAnnouncement(43);

    channel.emit(JSON.stringify(first));
    channel.emit(JSON.stringify(first));
    expect(pin.snapshot()).toEqual({ status: "pinned", key: first, failureReason: null });
    expect(router.snapshot().status).toBe("active");

    channel.emit(JSON.stringify(keyAnnouncement(44)));

    expect(pin.snapshot()).toEqual({
      status: "failed",
      key: null,
      failureReason: "runtime_evidence_transport_key_replaced_in_session",
    });
    expect(router.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_key_replaced_in_session",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
  });

  it("invalidates the router and pin on close or disposal and removes message listeners", () => {
    const closeChannel = new MockDataChannel();
    const closePin = new RuntimeEvidenceTransportKeyPin();
    const closeRouter = new RuntimeEvidenceTransportChannelRouter(closePin);
    closeRouter.bindAuthenticatedPeerDataChannel(closeChannel as unknown as RTCDataChannel);
    closeChannel.emit(JSON.stringify(keyAnnouncement(45)));
    closeChannel.closeRemotely();

    expect(closeRouter.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_authenticated_channel_closed",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
    expect(closePin.snapshot()).toEqual({ status: "disposed", key: null, failureReason: null });

    const disposeChannel = new MockDataChannel();
    const disposePin = new RuntimeEvidenceTransportKeyPin();
    const disposeRouter = new RuntimeEvidenceTransportChannelRouter(disposePin);
    const received = vi.fn();
    disposeRouter.onSupportEnvelope(received);
    disposeRouter.bindAuthenticatedPeerDataChannel(disposeChannel as unknown as RTCDataChannel);
    disposeRouter.dispose();
    disposeChannel.emit(JSON.stringify(signedEnvelopeFixture(signingIdentity(46)).input.envelope));

    expect(received).not.toHaveBeenCalled();
    expect(disposeRouter.snapshot()).toEqual({
      status: "disposed",
      failureReason: null,
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
    expect(disposePin.snapshot()).toEqual({ status: "disposed", key: null, failureReason: null });
  });

  it("rejects a second authenticated channel without reusing the first session pin", () => {
    const firstChannel = new MockDataChannel();
    const secondChannel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    const router = new RuntimeEvidenceTransportChannelRouter(pin);
    router.bindAuthenticatedPeerDataChannel(firstChannel as unknown as RTCDataChannel);
    const announcement = keyAnnouncement(47);
    firstChannel.emit(JSON.stringify(announcement));

    router.bindAuthenticatedPeerDataChannel(secondChannel as unknown as RTCDataChannel);
    secondChannel.emit(JSON.stringify(keyAnnouncement(48)));

    expect(router.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_authenticated_channel_invalid",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
    expect(pin.snapshot()).toEqual({ status: "pinned", key: announcement, failureReason: null });
  });

  it("bounds retained support envelopes and permits listener cleanup", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    const router = new RuntimeEvidenceTransportChannelRouter(pin, {
      maxRetainedSupportEnvelopeCount: 2,
    });
    const received = vi.fn();
    const unsubscribe = router.onSupportEnvelope(received);
    router.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    channel.emit(JSON.stringify(keyAnnouncement(49)));
    const first = JSON.stringify(signedEnvelopeFixture(signingIdentity(49)).input.envelope);
    const second = JSON.stringify(signedEnvelopeFixture(signingIdentity(50)).input.envelope);
    const third = JSON.stringify(signedEnvelopeFixture(signingIdentity(51)).input.envelope);

    channel.emit(first);
    unsubscribe();
    channel.emit(second);
    channel.emit(third);

    expect(received).toHaveBeenCalledTimes(1);
    expect(received).toHaveBeenCalledWith(first);
    expect(router.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_retention_capacity_exhausted",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
    expect(router.drainSupportEnvelopes()).toEqual([]);
  });

  it("refuses a recognized support envelope until the channel key is pinned", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    const router = new RuntimeEvidenceTransportChannelRouter(pin);
    const received = vi.fn();
    router.onSupportEnvelope(received);
    router.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    channel.emit(JSON.stringify(signedEnvelopeFixture(signingIdentity(52)).input.envelope));

    expect(router.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_support_envelope_before_key",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
    expect(pin.snapshot()).toEqual({ status: "pending", key: null, failureReason: null });
    expect(received).not.toHaveBeenCalled();
  });

  it("keeps direct and routed pin ownership mutually exclusive", () => {
    const directChannel = new MockDataChannel();
    const directPin = new RuntimeEvidenceTransportKeyPin();
    directPin.bindAuthenticatedPeerDataChannel(directChannel as unknown as RTCDataChannel);
    const competingRouter = new RuntimeEvidenceTransportChannelRouter(directPin);
    competingRouter.bindAuthenticatedPeerDataChannel(
      new MockDataChannel() as unknown as RTCDataChannel,
    );

    expect(competingRouter.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_authenticated_channel_invalid",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
    directChannel.emit(JSON.stringify(keyAnnouncement(53)));
    expect(directPin.snapshot().status).toBe("pinned");

    const routerChannel = new MockDataChannel();
    const routedPin = new RuntimeEvidenceTransportKeyPin();
    const firstRouter = new RuntimeEvidenceTransportChannelRouter(routedPin);
    const secondRouter = new RuntimeEvidenceTransportChannelRouter(routedPin);
    const firstRouterReceived = vi.fn();
    firstRouter.onSupportEnvelope(firstRouterReceived);
    firstRouter.bindAuthenticatedPeerDataChannel(routerChannel as unknown as RTCDataChannel);
    secondRouter.bindAuthenticatedPeerDataChannel(
      new MockDataChannel() as unknown as RTCDataChannel,
    );

    expect(firstRouter.snapshot().status).toBe("active");
    expect(secondRouter.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_authenticated_channel_invalid",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
    secondRouter.dispose();
    expect(firstRouter.snapshot().status).toBe("active");
    expect(routedPin.snapshot()).toEqual({ status: "pending", key: null, failureReason: null });

    for (const conflictingChannel of [
      new MockDataChannel("wrong-label"),
      new MockDataChannel(RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL, "closed"),
    ]) {
      expect(routedPin.bindAuthenticatedPeerDataChannel(
        conflictingChannel as unknown as RTCDataChannel,
      )).toBe(false);
      expect(routedPin.snapshot()).toEqual({
        status: "pending",
        key: null,
        failureReason: null,
      });
      expect(firstRouter.snapshot().status).toBe("active");
    }

    const announcement = keyAnnouncement(54);
    const serializedEnvelope = JSON.stringify(signedEnvelopeFixture(signingIdentity(54)).input.envelope);
    routerChannel.emit(JSON.stringify(announcement));
    routerChannel.emit(serializedEnvelope);
    expect(routedPin.snapshot()).toEqual({ status: "pinned", key: announcement, failureReason: null });
    expect(firstRouter.snapshot()).toMatchObject({
      status: "active",
      failureReason: null,
      retainedSupportEnvelopeCount: 1,
    });
    expect(firstRouterReceived).toHaveBeenCalledWith(serializedEnvelope);
  });

  it("tears down an owner router when its key pin is externally disposed", () => {
    const channel = new MockDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    const router = new RuntimeEvidenceTransportChannelRouter(pin);
    const received = vi.fn();
    router.onSupportEnvelope(received);
    router.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    const identity = signingIdentity(55);
    const serializedEnvelope = JSON.stringify(signedEnvelopeFixture(identity).input.envelope);
    channel.emit(JSON.stringify(identity.announcement));
    channel.emit(serializedEnvelope);
    expect(router.snapshot().retainedSupportEnvelopeCount).toBe(1);

    pin.dispose();
    channel.emit(serializedEnvelope);

    expect(router.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_key_pin_disposed",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
    expect(received).toHaveBeenCalledTimes(1);
  });

  it("rejects proxy, accessor, and extra-field limit policies without executing accessors", () => {
    const accessor = vi.fn(() => {
      throw new Error("limit accessor must not execute");
    });
    const accessorLimits = {} as Record<string, unknown>;
    Object.defineProperty(accessorLimits, "maxMessageBytes", {
      enumerable: true,
      get: accessor,
    });

    for (const limits of [
      new Proxy({}, {}),
      accessorLimits,
      { maxMessageBytes: 32, unexpected: true },
    ]) {
      expect(() => new RuntimeEvidenceTransportChannelRouter(
        new RuntimeEvidenceTransportKeyPin(),
        limits,
      )).toThrow("runtime_evidence_transport_router_limits_invalid");
    }
    expect(accessor).not.toHaveBeenCalled();
  });

  it("uses fatal UTF-8 and generic byte bounds before parsing or retaining records", () => {
    const malformedChannel = new MockDataChannel();
    const malformedRouter = new RuntimeEvidenceTransportChannelRouter(
      new RuntimeEvidenceTransportKeyPin(),
    );
    malformedRouter.bindAuthenticatedPeerDataChannel(
      malformedChannel as unknown as RTCDataChannel,
    );
    malformedChannel.emit(new Uint8Array([0xff]));
    expect(malformedRouter.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_message_encoding_invalid",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });

    const identity = signingIdentity(54);
    const serializedEnvelope = JSON.stringify(signedEnvelopeFixture(identity).input.envelope);
    const messageLimitChannel = new MockDataChannel();
    const messageLimitPin = new RuntimeEvidenceTransportKeyPin();
    const messageLimitRouter = new RuntimeEvidenceTransportChannelRouter(messageLimitPin, {
      maxMessageBytes: Buffer.byteLength(serializedEnvelope, "utf8") - 1,
    });
    messageLimitRouter.bindAuthenticatedPeerDataChannel(
      messageLimitChannel as unknown as RTCDataChannel,
    );
    messageLimitChannel.emit(JSON.stringify(identity.announcement));
    expect(messageLimitPin.snapshot().status).toBe("pinned");
    messageLimitChannel.emit(serializedEnvelope);
    expect(messageLimitRouter.snapshot()).toMatchObject({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_message_byte_limit_exceeded",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });

    const retainedByteLength = Buffer.byteLength(serializedEnvelope, "utf8");
    const retainedLimitChannel = new MockDataChannel();
    const retainedLimitPin = new RuntimeEvidenceTransportKeyPin();
    const retainedLimitRouter = new RuntimeEvidenceTransportChannelRouter(retainedLimitPin, {
      maxMessageBytes: retainedByteLength,
      maxRetainedSupportEnvelopeBytes: retainedByteLength * 2 - 1,
      maxRetainedSupportEnvelopeCount: 3,
    });
    retainedLimitRouter.bindAuthenticatedPeerDataChannel(
      retainedLimitChannel as unknown as RTCDataChannel,
    );
    retainedLimitChannel.emit(JSON.stringify(identity.announcement));
    retainedLimitChannel.emit(serializedEnvelope);
    retainedLimitChannel.emit(serializedEnvelope);

    expect(retainedLimitRouter.snapshot()).toEqual({
      status: "failed",
      failureReason: "runtime_evidence_transport_router_retained_byte_capacity_exhausted",
      retainedSupportEnvelopeCount: 0,
      retainedSupportEnvelopeBytes: 0,
    });
  });
});

describe("verifyRuntimeEvidenceTransportSupportEnvelopeOffline", () => {
  it("matches the direct MJS export and online verification for valid evidence", () => {
    const identity = signingIdentity(31);
    const key = parsedVerificationKey(identity.announcement);
    const fixture = signedEnvelopeFixture(identity);
    const context = verificationContext(fixture.input);
    const directMjsVerification = verifySharedOffline(
      key,
      fixture.input.envelope,
      fixture.input.observedPayload,
      context,
    );
    const typedVerification = verifyOffline(key, fixture);
    const onlineVerification = new RuntimeEvidenceTransportReceiptConsumer(
      pinAnnouncement(identity.announcement),
      new SessionRuntimeEvidenceTransportReplayStore(),
      () => NOW_NS,
    ).consumeSupportEnvelope(fixture.input);

    expect(typedVerification).toEqual(directMjsVerification);
    expect(typedVerification).toEqual(onlineVerification);
    expect(typedVerification).toEqual({
      verified: true,
      reason: null,
      receiptId: fixture.receipt.receiptId,
      observationContextHash: fixture.receipt.observationContextHash,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.isFrozen(typedVerification)).toBe(true);
  });

  it("omits wall-clock freshness and mutable replay policy", () => {
    const identity = signingIdentity(32);
    const key = parsedVerificationKey(identity.announcement);
    const pin = pinAnnouncement(identity.announcement);
    const freshnessCases = [
      {
        fixture: signedEnvelopeFixture({
          ...identity,
          issuedAtUnixNs: NOW_NS - 300_000_000_001n,
        }),
        reason: "runtime_evidence_transport_receipt_expired",
      },
      {
        fixture: signedEnvelopeFixture({
          ...identity,
          issuedAtUnixNs: NOW_NS + 30_000_000_001n,
          nonceSeed: "7",
        }),
        reason: "runtime_evidence_transport_receipt_from_future",
      },
    ];
    for (const { fixture, reason } of freshnessCases) {
      expect(verifyOffline(key, fixture).verified).toBe(true);
      const online = new RuntimeEvidenceTransportReceiptConsumer(
        pin,
        new SessionRuntimeEvidenceTransportReplayStore(),
        () => NOW_NS,
      );
      expect(online.consumeSupportEnvelope(fixture.input).reason).toBe(reason);
    }

    const replayed = signedEnvelopeFixture({
      ...identity,
      sequence: 2n,
      nonceSeed: "8",
    });
    expect(verifyOffline(key, replayed).verified).toBe(true);
    expect(verifyOffline(key, replayed).verified).toBe(true);
    const online = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      new SessionRuntimeEvidenceTransportReplayStore(),
      () => NOW_NS,
    );
    expect(online.consumeSupportEnvelope(replayed.input).verified).toBe(true);
    expect(online.consumeSupportEnvelope(replayed.input).reason)
      .toBe("runtime_evidence_transport_receipt_replayed");
  });

  it("recomputes key identity and rejects substitution or extra key aliases", () => {
    const identity = signingIdentity(33);
    const otherIdentity = signingIdentity(34);
    const key = parsedVerificationKey(identity.announcement);
    const otherKey = parsedVerificationKey(otherIdentity.announcement);
    const fixture = signedEnvelopeFixture(identity);
    const alteredKeys = [
      { ...key, keyId: `${KEY_ID_PREFIX}${"f".repeat(64)}` },
      {
        ...key,
        keyAnnouncementId: `${KEY_ANNOUNCEMENT_ID_PREFIX}${"f".repeat(64)}`,
      },
      { ...key, publicKey: otherKey.publicKey },
      { ...key, key_id: key.keyId },
    ];

    for (const alteredKey of alteredKeys) {
      expect(verifyOffline(
        alteredKey as RuntimeEvidenceTransportVerificationKey,
        fixture,
      ).reason).toBe("runtime_evidence_transport_verification_key_invalid");
    }
    expect(verifyOffline(otherKey, fixture).reason)
      .toBe("runtime_evidence_transport_verification_context_mismatch");
  });

  it("rejects altered signatures, payloads, subjects, and transport context", () => {
    const identity = signingIdentity(35);
    const key = parsedVerificationKey(identity.announcement);
    const forged = signedEnvelopeFixture(identity);
    forged.receipt.signature = `ed25519:${Buffer.alloc(64).toString("base64url")}`;
    expect(verifyOffline(key, forged).reason)
      .toBe("runtime_evidence_transport_signature_mismatch");

    const fixture = signedEnvelopeFixture(identity);
    expect(verifyOffline(key, fixture, {
      observedPayload: `${fixture.input.observedPayload} `,
    }).reason).toBe("runtime_evidence_transport_observed_payload_hash_mismatch");

    const context = verificationContext(fixture.input);
    const alteredContexts: RuntimeEvidenceTransportVerificationContext[] = [
      { ...context, subjectCanonicalBytes: "different-subject" },
      { ...context, subjectIdentityNamespace: "synthi.test.other_subject.v1" },
      { ...context, runnerProcessId: context.runnerProcessId + 1 },
      { ...context, runtimeSessionId: "runner-runtime-session-other-01" },
      { ...context, runnerChallenge: "b".repeat(32) },
      { ...context, transportSessionId: "session-other-source-tree-01" },
    ];
    for (const alteredContext of alteredContexts) {
      expect(verifyOffline(key, fixture, { context: alteredContext }).reason)
        .toBe("runtime_evidence_transport_verification_context_mismatch");
    }
  });

  it("rejects altered IDs and non-exact envelope, receipt, and context shapes", () => {
    const identity = signingIdentity(36);
    const key = parsedVerificationKey(identity.announcement);

    const alteredReceiptId = signedEnvelopeFixture(identity);
    alteredReceiptId.receipt.receiptId =
      `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"f".repeat(64)}`;
    expect(verifyOffline(key, alteredReceiptId).reason)
      .toBe("runtime_evidence_transport_receipt_id_mismatch");

    const alteredContextHash = signedEnvelopeFixture(identity);
    alteredContextHash.receipt.observationContextHash = `sha256:${"f".repeat(64)}`;
    expect(verifyOffline(key, alteredContextHash).reason)
      .toBe("runtime_evidence_transport_verification_context_hash_mismatch");

    const fixture = signedEnvelopeFixture(identity);
    const context = verificationContext(fixture.input);
    const alteredIdentityContexts: RuntimeEvidenceTransportVerificationContext[] = [
      { ...context, requestId: `gpu-reload:request:${"e".repeat(32)}` },
      { ...context, sourceEditId: `source-edit:sha256:${"e".repeat(64)}` },
      { ...context, observedRuntimeProofId: `gpu-runtime-proof:sha256:${"e".repeat(64)}` },
      { ...context, observedProofLedgerId: `gpu-ledger-proof:sha256:${"e".repeat(64)}` },
    ];
    for (const alteredContext of alteredIdentityContexts) {
      expect(verifyOffline(key, fixture, { context: alteredContext }).reason)
        .toBe("runtime_evidence_transport_verification_context_mismatch");
    }

    const aliasedReceipt = signedEnvelopeFixture(identity);
    const receiptId = aliasedReceipt.receipt.receiptId;
    delete aliasedReceipt.receipt.receiptId;
    aliasedReceipt.receipt.receipt_id = receiptId;
    expect(verifyOffline(key, aliasedReceipt).reason)
      .toBe("runtime_evidence_transport_receipt_field_shape_invalid");

    const extraEnvelopeField = signedEnvelopeFixture(identity);
    (extraEnvelopeField.input.envelope as Record<string, unknown>).verified = true;
    expect(verifyOffline(key, extraEnvelopeField).reason)
      .toBe("observed_runtime_evidence_envelope_shape_invalid");

    const contextWithAlias = {
      ...verificationContext(fixture.input),
      runner_process_id: fixture.input.runnerProcessId,
    } as RuntimeEvidenceTransportVerificationContext;
    expect(verifyOffline(key, fixture, { context: contextWithAlias }).reason)
      .toBe("runtime_evidence_transport_verification_context_invalid");
  });

  it("rejects stateful accessors without reading substitution values", () => {
    const identity = signingIdentity(38);
    const otherIdentity = signingIdentity(39);
    const key = parsedVerificationKey(identity.announcement);
    const otherKey = parsedVerificationKey(otherIdentity.announcement);
    const fixture = signedEnvelopeFixture(identity);
    const getterReadCounts: Array<() => number> = [];

    const accessorKey = { ...key } as Record<string, unknown>;
    getterReadCounts.push(installStatefulGetter(
      accessorKey,
      "keyId",
      key.keyId,
      otherKey.keyId,
    ));
    expect(verifyOffline(
      accessorKey as unknown as RuntimeEvidenceTransportVerificationKey,
      fixture,
    ).reason).toBe("runtime_evidence_transport_verification_key_invalid");

    const accessorContext = {
      ...verificationContext(fixture.input),
    } as Record<string, unknown>;
    getterReadCounts.push(installStatefulGetter(
      accessorContext,
      "requestId",
      fixture.input.requestId,
      `gpu-reload:request:${"f".repeat(32)}`,
    ));
    expect(verifyOffline(key, fixture, {
      context: accessorContext as unknown as RuntimeEvidenceTransportVerificationContext,
    }).reason).toBe("runtime_evidence_transport_verification_context_invalid");

    const accessorEnvelopeFixture = signedEnvelopeFixture(identity);
    const envelope = accessorEnvelopeFixture.input.envelope as Record<string, unknown>;
    getterReadCounts.push(installStatefulGetter(
      envelope,
      "runtimeEvidenceTransportReceipt",
      accessorEnvelopeFixture.receipt,
      signedEnvelopeFixture(otherIdentity).receipt,
    ));
    expect(verifyOffline(key, accessorEnvelopeFixture).reason)
      .toBe("observed_runtime_evidence_envelope_shape_invalid");

    for (const field of ["nonce", "signature", "receiptId"] as const) {
      const accessorReceiptFixture = signedEnvelopeFixture(identity);
      const firstValue = accessorReceiptFixture.receipt[field];
      const laterValue = field === "nonce"
        ? "f".repeat(64)
        : field === "signature"
          ? `ed25519:${Buffer.alloc(64).toString("base64url")}`
          : `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"f".repeat(64)}`;
      getterReadCounts.push(installStatefulGetter(
        accessorReceiptFixture.receipt,
        field,
        firstValue,
        laterValue,
      ));
      expect(verifyOffline(key, accessorReceiptFixture).reason)
        .toBe("runtime_evidence_transport_receipt_field_shape_invalid");
    }

    const onlineFixture = signedEnvelopeFixture(identity);
    const onlineInput = { ...onlineFixture.input } as Record<string, unknown>;
    getterReadCounts.push(installStatefulGetter(
      onlineInput,
      "runnerProcessId",
      onlineFixture.input.runnerProcessId,
      onlineFixture.input.runnerProcessId + 1,
    ));
    const online = new RuntimeEvidenceTransportReceiptConsumer(
      pinAnnouncement(identity.announcement),
      new SessionRuntimeEvidenceTransportReplayStore(),
      () => NOW_NS,
    );
    expect(online.consumeSupportEnvelope(
      onlineInput as unknown as RuntimeEvidenceTransportSupportEnvelopeInput,
    ).reason).toBe("runtime_evidence_transport_verification_context_invalid");

    expect(getterReadCounts.map((readCount) => readCount()))
      .toEqual(new Array(getterReadCounts.length).fill(0));
  });

  it("rejects symbols, hidden fields, wrong prototypes, and proxies without traps", () => {
    const identity = signingIdentity(40);
    const key = parsedVerificationKey(identity.announcement);
    const fixture = signedEnvelopeFixture(identity);

    const symbolKey = { ...key } as Record<PropertyKey, unknown>;
    symbolKey[Symbol("key-alias")] = key.keyId;
    expect(verifyOffline(
      symbolKey as unknown as RuntimeEvidenceTransportVerificationKey,
      fixture,
    ).reason).toBe("runtime_evidence_transport_verification_key_invalid");

    const hiddenContext = {
      ...verificationContext(fixture.input),
    } as Record<string, unknown>;
    Object.defineProperty(hiddenContext, "requestId", {
      value: fixture.input.requestId,
      enumerable: false,
    });
    expect(verifyOffline(key, fixture, {
      context: hiddenContext as unknown as RuntimeEvidenceTransportVerificationContext,
    }).reason).toBe("runtime_evidence_transport_verification_context_invalid");

    const symbolEnvelopeFixture = signedEnvelopeFixture(identity);
    const symbolEnvelope = symbolEnvelopeFixture.input.envelope as Record<PropertyKey, unknown>;
    symbolEnvelope[Symbol("verified")] = true;
    expect(verifyOffline(key, symbolEnvelopeFixture).reason)
      .toBe("observed_runtime_evidence_envelope_shape_invalid");

    const hiddenReceiptFixture = signedEnvelopeFixture(identity);
    Object.defineProperty(hiddenReceiptFixture.receipt, "nonce", {
      value: hiddenReceiptFixture.receipt.nonce,
      enumerable: false,
    });
    expect(verifyOffline(key, hiddenReceiptFixture).reason)
      .toBe("runtime_evidence_transport_receipt_field_shape_invalid");

    const wrongPrototypeKey = Object.assign(Object.create({}), key);
    expect(verifyOffline(
      wrongPrototypeKey as RuntimeEvidenceTransportVerificationKey,
      fixture,
    ).reason).toBe("runtime_evidence_transport_verification_key_invalid");

    const wrongPrototypeContext = Object.assign(
      Object.create({}),
      verificationContext(fixture.input),
    ) as RuntimeEvidenceTransportVerificationContext;
    expect(verifyOffline(key, fixture, { context: wrongPrototypeContext }).reason)
      .toBe("runtime_evidence_transport_verification_context_invalid");

    const proxiedEnvelopeFixture = signedEnvelopeFixture(identity);
    let trapCalls = 0;
    const failTrap = (): never => {
      trapCalls += 1;
      throw new Error("proxy trap must not run");
    };
    const proxiedEnvelope = new Proxy(
      proxiedEnvelopeFixture.input.envelope as Record<string, unknown>,
      {
        get: failTrap,
        getOwnPropertyDescriptor: failTrap,
        getPrototypeOf: failTrap,
        ownKeys: failTrap,
      },
    );
    expect(verifyRuntimeEvidenceTransportSupportEnvelopeOffline(
      key,
      proxiedEnvelope,
      proxiedEnvelopeFixture.input.observedPayload,
      verificationContext(proxiedEnvelopeFixture.input),
    ).reason).toBe("observed_runtime_evidence_envelope_shape_invalid");
    expect(trapCalls).toBe(0);

    const revokedEnvelopeFixture = signedEnvelopeFixture(identity);
    const revokedEnvelope = Proxy.revocable(
      revokedEnvelopeFixture.input.envelope as Record<string, unknown>,
      {},
    );
    revokedEnvelope.revoke();
    expect(verifyRuntimeEvidenceTransportSupportEnvelopeOffline(
      key,
      revokedEnvelope.proxy,
      revokedEnvelopeFixture.input.observedPayload,
      verificationContext(revokedEnvelopeFixture.input),
    ).reason).toBe("observed_runtime_evidence_envelope_shape_invalid");
  });

  it("matches same-realm verification for VM-realm Uint8Array inputs", () => {
    const identity = signingIdentity(41);
    const key = parsedVerificationKey(identity.announcement);
    const fixture = signedEnvelopeFixture(identity);
    const context = verificationContext(fixture.input);
    const sameRealmPayload = Uint8Array.from(Buffer.from(fixture.input.observedPayload));
    const sameRealmSubject = Uint8Array.from(Buffer.from(context.subjectCanonicalBytes));
    const crossRealmPayload = crossRealmUint8Array(sameRealmPayload);
    const crossRealmSubject = crossRealmUint8Array(sameRealmSubject);

    expect(crossRealmPayload instanceof Uint8Array).toBe(false);
    expect(crossRealmSubject instanceof Uint8Array).toBe(false);
    const sameRealm = verifyOffline(key, fixture, {
      observedPayload: sameRealmPayload,
      context: { ...context, subjectCanonicalBytes: sameRealmSubject },
    });
    const crossRealmPayloadOnly = verifyOffline(key, fixture, {
      observedPayload: crossRealmPayload,
      context: { ...context, subjectCanonicalBytes: sameRealmSubject },
    });
    const crossRealmSubjectOnly = verifyOffline(key, fixture, {
      observedPayload: sameRealmPayload,
      context: { ...context, subjectCanonicalBytes: crossRealmSubject },
    });
    const crossRealmBoth = verifyOffline(key, fixture, {
      observedPayload: crossRealmPayload,
      context: { ...context, subjectCanonicalBytes: crossRealmSubject },
    });

    expect(sameRealm.verified).toBe(true);
    expect(crossRealmPayloadOnly).toEqual(sameRealm);
    expect(crossRealmSubjectOnly).toEqual(sameRealm);
    expect(crossRealmBoth).toEqual(sameRealm);
  });

  it("rejects DataView and non-Uint8 typed-array byte inputs", () => {
    const identity = signingIdentity(42);
    const key = parsedVerificationKey(identity.announcement);
    const fixture = signedEnvelopeFixture(identity);
    const context = verificationContext(fixture.input);
    const invalidPayloads = [
      new DataView(new ArrayBuffer(8)),
      new Uint16Array([1, 2]),
      new Uint8ClampedArray([1, 2]),
    ];
    for (const observedPayload of invalidPayloads) {
      expect(verifyOffline(key, fixture, {
        observedPayload: observedPayload as unknown as Uint8Array,
      }).reason).toBe("runtime_evidence_transport_verification_context_invalid");
    }

    const invalidSubjects = [
      new DataView(new ArrayBuffer(8)),
      new Int8Array([1, 2]),
      new Uint32Array([1, 2]),
    ];
    for (const subjectCanonicalBytes of invalidSubjects) {
      expect(verifyOffline(key, fixture, {
        context: {
          ...context,
          subjectCanonicalBytes: subjectCanonicalBytes as unknown as Uint8Array,
        },
      }).reason).toBe("runtime_evidence_transport_verification_context_invalid");
    }
  });

  it("rejects serialized success-authority claims and always returns support-only flags", () => {
    const identity = signingIdentity(37);
    const key = parsedVerificationKey(identity.announcement);
    const claims: Array<Readonly<{ field: string; value: unknown }>> = [
      { field: "proofAuthority", value: "worker_signed_gpu_hmr_acceptance" },
      { field: "acceptedForGpuHmr", value: true },
      { field: "gpuHmrSuccess", value: true },
      { field: "canSatisfyRuntimeProof", value: true },
    ];

    for (const claim of claims) {
      const fixture = signedEnvelopeFixture(identity);
      (fixture.input.envelope as Record<string, unknown>)[claim.field] = claim.value;
      expect(verifyOffline(key, fixture)).toEqual({
        verified: false,
        reason: "observed_runtime_evidence_envelope_shape_invalid",
        receiptId: null,
        observationContextHash: null,
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        canSatisfyRuntimeProof: false,
      });
    }
  });
});

describe("RuntimeEvidenceTransportReceiptConsumer", () => {
  it("prepares verified support without consuming replay state", () => {
    const identity = signingIdentity(21);
    const pin = pinAnnouncement(identity.announcement);
    const consumeIfNewer = vi.fn(() => null);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer },
      () => NOW_NS,
    );
    const fixture = signedEnvelopeFixture(identity);

    const preparation = consumer.prepareSupportEnvelope(fixture.input);

    expect(preparation).toMatchObject({
      schemaVersion: "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1",
      proofAuthority:
        "cryptographic_and_freshness_preparation_only_replay_not_committed",
      prepared: true,
      reason: null,
      freshnessChecked: true,
      replayChecked: false,
      receiptId: fixture.receipt.receiptId,
      observationContextHash: fixture.receipt.observationContextHash,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(preparation).not.toHaveProperty("verified");
    expect(preparation).not.toHaveProperty("verification");
    expect(preparation.capability).not.toBeNull();
    expect(consumeIfNewer).not.toHaveBeenCalled();
  });

  it("commits one prepared capability exactly once", () => {
    const identity = signingIdentity(22);
    const pin = pinAnnouncement(identity.announcement);
    const consumeIfNewer = vi.fn(() => null);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer },
      () => NOW_NS,
    );
    const fixture = signedEnvelopeFixture(identity);
    const preparation = consumer.prepareSupportEnvelope(fixture.input);
    if (preparation.capability === null) throw new Error("preparation failed");

    expect(consumer.commitPreparedSupportEnvelope(preparation.capability)).toMatchObject({
      verified: true,
      receiptId: preparation.receiptId,
      observationContextHash: preparation.observationContextHash,
    });
    expect(consumeIfNewer).toHaveBeenCalledTimes(1);
    expect(consumer.commitPreparedSupportEnvelope(preparation.capability)).toMatchObject({
      verified: false,
      reason: "runtime_evidence_transport_prepared_capability_already_used",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(consumeIfNewer).toHaveBeenCalledTimes(1);
  });

  it("discards prepared capabilities without consuming replay or retaining capacity", () => {
    const identity = signingIdentity(46);
    const pin = pinAnnouncement(identity.announcement);
    const consumeIfNewer = vi.fn(() => null);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer },
      () => NOW_NS,
    );
    const fixture = signedEnvelopeFixture(identity);

    for (let attempt = 0; attempt < 300; attempt += 1) {
      const preparation = consumer.prepareSupportEnvelope(fixture.input);
      if (preparation.capability === null) throw new Error("preparation failed");
      expect(consumer.discardPreparedSupportEnvelope(preparation.capability)).toBe(true);
      expect(consumer.discardPreparedSupportEnvelope(preparation.capability)).toBe(false);
      expect(consumer.commitPreparedSupportEnvelope(preparation.capability)).toMatchObject({
        verified: false,
        reason: "runtime_evidence_transport_prepared_capability_already_used",
      });
    }
    expect(consumeIfNewer).not.toHaveBeenCalled();

    const finalPreparation = consumer.prepareSupportEnvelope(fixture.input);
    if (finalPreparation.capability === null) throw new Error("preparation failed");
    const serializedCapability = structuredClone(finalPreparation.capability);
    const foreignConsumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer: vi.fn(() => null) },
      () => NOW_NS,
    );
    expect(consumer.discardPreparedSupportEnvelope(serializedCapability)).toBe(false);
    expect(foreignConsumer.discardPreparedSupportEnvelope(finalPreparation.capability))
      .toBe(false);
    expect(consumer.commitPreparedSupportEnvelope(finalPreparation.capability).verified)
      .toBe(true);
    expect(consumeIfNewer).toHaveBeenCalledTimes(1);
  });

  it("refuses replay at commit after an independently prepared duplicate", () => {
    const identity = signingIdentity(23);
    const pin = pinAnnouncement(identity.announcement);
    const replayStore = new SessionRuntimeEvidenceTransportReplayStore();
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      replayStore,
      () => NOW_NS,
    );
    const fixture = signedEnvelopeFixture(identity);
    const first = consumer.prepareSupportEnvelope(fixture.input);
    const duplicate = consumer.prepareSupportEnvelope(fixture.input);
    if (first.capability === null || duplicate.capability === null) {
      throw new Error("preparation failed");
    }

    expect(consumer.commitPreparedSupportEnvelope(first.capability).verified).toBe(true);
    expect(consumer.commitPreparedSupportEnvelope(duplicate.capability)).toMatchObject({
      verified: false,
      reason: "runtime_evidence_transport_receipt_replayed",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  });

  it("rejects foreign and serialized capability identities", () => {
    const identity = signingIdentity(24);
    const pin = pinAnnouncement(identity.announcement);
    const ownerConsumeIfNewer = vi.fn(() => null);
    const foreignConsumeIfNewer = vi.fn(() => null);
    const owner = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer: ownerConsumeIfNewer },
      () => NOW_NS,
    );
    const foreign = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer: foreignConsumeIfNewer },
      () => NOW_NS,
    );
    const preparation = owner.prepareSupportEnvelope(signedEnvelopeFixture(identity).input);
    if (preparation.capability === null) throw new Error("preparation failed");
    const serialized = JSON.parse(JSON.stringify(preparation.capability)) as
      typeof preparation.capability;
    const trapCapability = new Proxy({}, {
      get() {
        throw new Error("capability properties must not be inspected");
      },
      ownKeys() {
        throw new Error("capability keys must not be inspected");
      },
    }) as typeof preparation.capability;

    expect(foreign.commitPreparedSupportEnvelope(preparation.capability).reason)
      .toBe("runtime_evidence_transport_prepared_capability_invalid");
    expect(owner.commitPreparedSupportEnvelope(serialized).reason)
      .toBe("runtime_evidence_transport_prepared_capability_invalid");
    expect(owner.commitPreparedSupportEnvelope(trapCapability).reason)
      .toBe("runtime_evidence_transport_prepared_capability_invalid");
    expect(foreignConsumeIfNewer).not.toHaveBeenCalled();
    expect(ownerConsumeIfNewer).not.toHaveBeenCalled();
    expect(owner.commitPreparedSupportEnvelope(preparation.capability).verified).toBe(true);
    expect(ownerConsumeIfNewer).toHaveBeenCalledTimes(1);
  });

  it("refuses commit after the pinned key is invalidated", () => {
    const identity = signingIdentity(25);
    const pin = pinAnnouncement(identity.announcement);
    const consumeIfNewer = vi.fn(() => null);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer },
      () => NOW_NS,
    );
    const preparation = consumer.prepareSupportEnvelope(signedEnvelopeFixture(identity).input);
    if (preparation.capability === null) throw new Error("preparation failed");

    pin.dispose();

    expect(consumer.commitPreparedSupportEnvelope(preparation.capability)).toMatchObject({
      verified: false,
      reason: "runtime_evidence_transport_verification_key_not_pinned",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(consumeIfNewer).not.toHaveBeenCalled();
    expect(consumer.commitPreparedSupportEnvelope(preparation.capability).reason)
      .toBe("runtime_evidence_transport_prepared_capability_already_used");
  });

  it("refuses clock-callback trust invalidation before replay commit", () => {
    const identity = signingIdentity(27);
    const pin = pinAnnouncement(identity.announcement);
    const consumeIfNewer = vi.fn(() => null);
    let clockCalls = 0;
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer },
      () => {
        clockCalls += 1;
        if (clockCalls === 2) pin.dispose();
        return NOW_NS;
      },
    );
    const preparation = consumer.prepareSupportEnvelope(
      signedEnvelopeFixture(identity).input,
    );
    if (preparation.capability === null) throw new Error("preparation failed");

    expect(consumer.commitPreparedSupportEnvelope(preparation.capability)).toMatchObject({
      verified: false,
      reason: "runtime_evidence_transport_verification_key_not_pinned",
    });
    expect(consumeIfNewer).not.toHaveBeenCalled();
  });

  it("refuses replay-callback disposal after consuming replay state", () => {
    const identity = signingIdentity(28);
    const pin = pinAnnouncement(identity.announcement);
    let consumer!: RuntimeEvidenceTransportReceiptConsumer;
    const consumeIfNewer = vi.fn(() => {
      consumer.dispose();
      return null;
    });
    consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer },
      () => NOW_NS,
    );
    const preparation = consumer.prepareSupportEnvelope(
      signedEnvelopeFixture(identity).input,
    );
    if (preparation.capability === null) throw new Error("preparation failed");

    expect(consumer.commitPreparedSupportEnvelope(preparation.capability)).toMatchObject({
      verified: false,
      reason: "runtime_evidence_transport_consumer_disposed",
    });
    expect(consumeIfNewer).toHaveBeenCalledTimes(1);
  });

  it("rechecks freshness before committing prepared support", () => {
    const identity = signingIdentity(26);
    const pin = pinAnnouncement(identity.announcement);
    const consumeIfNewer = vi.fn(() => null);
    let nowUnixNs = NOW_NS;
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer },
      () => nowUnixNs,
    );
    const preparation = consumer.prepareSupportEnvelope(signedEnvelopeFixture(identity).input);
    if (preparation.capability === null) throw new Error("preparation failed");

    nowUnixNs = NOW_NS + 300_000_000_001n;

    expect(consumer.commitPreparedSupportEnvelope(preparation.capability)).toMatchObject({
      verified: false,
      reason: "runtime_evidence_transport_prepared_capability_expired",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(consumeIfNewer).not.toHaveBeenCalled();
  });

  it("bounds abandoned preparations and prunes them after their lifetime", () => {
    const identity = signingIdentity(29);
    const pin = pinAnnouncement(identity.announcement);
    let nowUnixNs = NOW_NS;
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer: vi.fn(() => null) },
      () => nowUnixNs,
    );
    const fixture = signedEnvelopeFixture(identity);
    const retained = Array.from({ length: 255 }, () =>
      consumer.prepareSupportEnvelope(fixture.input));
    expect(retained.every((item) => item.prepared)).toBe(true);

    expect(consumer.prepareSupportEnvelope(fixture.input)).toMatchObject({
      prepared: false,
      reason: "runtime_evidence_transport_prepared_capability_capacity_exhausted",
      replayChecked: false,
    });
    expect(consumer.consumeSupportEnvelope(fixture.input)).toMatchObject({
      verified: true,
      reason: null,
    });

    nowUnixNs += 30_000_000_001n;
    expect(consumer.prepareSupportEnvelope(fixture.input)).toMatchObject({
      prepared: true,
      reason: null,
      replayChecked: false,
    });
  });

  it("keeps the compatibility consume path to one clock observation", () => {
    const identity = signingIdentity(30);
    const pin = pinAnnouncement(identity.announcement);
    const clockUnixNs = vi.fn(() => NOW_NS);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer: vi.fn(() => null) },
      clockUnixNs,
    );

    expect(consumer.consumeSupportEnvelope(signedEnvelopeFixture(identity).input).verified)
      .toBe(true);
    expect(clockUnixNs).toHaveBeenCalledTimes(1);
  });

  it("suppresses compatibility-consume reentry from injected callbacks", () => {
    const identity = signingIdentity(31);
    const pin = pinAnnouncement(identity.announcement);
    const fixture = signedEnvelopeFixture(identity);
    let consumer!: RuntimeEvidenceTransportReceiptConsumer;
    let recursive: RuntimeEvidenceTransportSupportVerification | null = null;
    const clockUnixNs = vi.fn(() => {
      if (recursive === null) {
        recursive = consumer.consumeSupportEnvelope(fixture.input);
      }
      return NOW_NS;
    });
    consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer: vi.fn(() => null) },
      clockUnixNs,
    );

    expect(consumer.consumeSupportEnvelope(fixture.input).verified).toBe(true);
    expect(recursive).toMatchObject({
      verified: false,
      reason: "runtime_evidence_transport_compatibility_consume_reentry_suppressed",
    });
    expect(clockUnixNs).toHaveBeenCalledTimes(1);
  });

  it("suppresses preparation reentry before pending state is installed", () => {
    const identity = signingIdentity(32);
    const pin = pinAnnouncement(identity.announcement);
    const fixture = signedEnvelopeFixture(identity);
    let consumer!: RuntimeEvidenceTransportReceiptConsumer;
    let recursive: ReturnType<
      RuntimeEvidenceTransportReceiptConsumer["prepareSupportEnvelope"]
    > | null = null;
    const clockUnixNs = vi.fn(() => {
      if (recursive === null) {
        recursive = consumer.prepareSupportEnvelope(fixture.input);
      }
      return NOW_NS;
    });
    consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer: vi.fn(() => null) },
      clockUnixNs,
    );

    expect(consumer.prepareSupportEnvelope(fixture.input).prepared).toBe(true);
    expect(recursive).toMatchObject({
      prepared: false,
      reason: "runtime_evidence_transport_preparation_reentry_suppressed",
      replayChecked: false,
    });
    expect(clockUnixNs).toHaveBeenCalledTimes(1);
  });

  it("verifies a fresh receipt against only the live channel-pinned key", () => {
    const identity = signingIdentity(11);
    const pin = pinAnnouncement(identity.announcement);
    const fixture = signedEnvelopeFixture(identity);
    const consumeIfNewer = vi.fn(() => null);
    const consumer = new RuntimeEvidenceTransportReceiptConsumer(
      pin,
      { consumeIfNewer },
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
    expect(consumeIfNewer).toHaveBeenCalledTimes(1);
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
