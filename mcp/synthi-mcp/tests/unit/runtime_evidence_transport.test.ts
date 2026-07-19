import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RTCDataChannel } from "werift";
import {
  RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
  RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
  RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
  RuntimeEvidenceTransportKeyPin,
  parseRuntimeEvidenceTransportVerificationKey,
} from "../../src/runtime_evidence_transport.js";

const PRODUCER = "synthi-webrtc-compiler-worker";
const KEY_ID_PREFIX = "gpu-hmr-runtime-evidence-transport-key:sha256:";
const KEY_ANNOUNCEMENT_ID_PREFIX =
  "gpu-hmr-runtime-evidence-transport-key-announcement:sha256:";
const WORKER_INSTANCE_ID_PREFIX = "gpu-hmr-worker-instance:sha256:";

class MockDataChannel extends EventTarget {
  constructor(readonly label: string = RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL) {
    super();
  }

  emit(data: unknown): void {
    const event = new Event("message");
    (event as unknown as { data: unknown }).data = data;
    this.dispatchEvent(event);
  }
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function keyAnnouncement(seed: number): Record<string, unknown> {
  const publicKeyBytes = Buffer.alloc(32, seed);
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
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    channel.emit(JSON.stringify(keyAnnouncement(3)));
    channel.emit(JSON.stringify(keyAnnouncement(4)));

    expect(pin.snapshot()).toMatchObject({
      status: "failed",
      key: null,
      failureReason: "runtime_evidence_transport_key_replaced_in_session",
    });
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
    pin.dispose();
    expect(pin.snapshot()).toEqual({ status: "disposed", key: null, failureReason: null });
  });
});
