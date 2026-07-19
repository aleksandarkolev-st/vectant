import { createHash } from "node:crypto";
import type { RTCDataChannel } from "werift";

export const RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL =
  "gpu-hmr-evidence-transport";
export const RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA =
  "synthi.gpu_hmr.runtime_evidence_transport_verification_key.v1";
export const RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM = "ed25519";

const RUNTIME_EVIDENCE_TRANSPORT_PRODUCER = "synthi-webrtc-compiler-worker";
const KEY_ID_PREFIX = "gpu-hmr-runtime-evidence-transport-key:sha256:";
const KEY_ANNOUNCEMENT_ID_PREFIX =
  "gpu-hmr-runtime-evidence-transport-key-announcement:sha256:";
const WORKER_INSTANCE_ID_PREFIX = "gpu-hmr-worker-instance:sha256:";

export interface RuntimeEvidenceTransportVerificationKey {
  readonly schemaVersion: typeof RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA;
  readonly algorithm: typeof RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM;
  readonly keyId: string;
  readonly producer: typeof RUNTIME_EVIDENCE_TRANSPORT_PRODUCER;
  readonly workerInstanceId: string;
  readonly workerProcessId: string;
  readonly publicKey: string;
  readonly keyAnnouncementId: string;
}

export interface RuntimeEvidenceTransportKeyPinSnapshot {
  readonly status: "pending" | "pinned" | "failed" | "disposed";
  readonly key: RuntimeEvidenceTransportVerificationKey | null;
  readonly failureReason: string | null;
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;
  return value as Record<string, unknown>;
}

function canonicalPrefixedSha256(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-f0-9]{64}$`).test(value);
}

function canonicalWorkerProcessId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 0xffff_ffff;
}

function decodeCanonicalPublicKey(value: unknown): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) return null;
  return decoded;
}

export function parseRuntimeEvidenceTransportVerificationKey(
  value: unknown,
): RuntimeEvidenceTransportVerificationKey | null {
  const raw = exactObject(value);
  if (raw === null) return null;
  const requiredKeys = [
    "algorithm",
    "keyAnnouncementId",
    "keyId",
    "producer",
    "publicKey",
    "schemaVersion",
    "workerInstanceId",
    "workerProcessId",
  ];
  if (
    Object.keys(raw).length !== requiredKeys.length
    || requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(raw, key))
  ) {
    return null;
  }
  if (
    raw.schemaVersion !== RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA
    || raw.algorithm !== RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM
    || raw.producer !== RUNTIME_EVIDENCE_TRANSPORT_PRODUCER
    || !canonicalPrefixedSha256(raw.keyId, KEY_ID_PREFIX)
    || !canonicalPrefixedSha256(raw.workerInstanceId, WORKER_INSTANCE_ID_PREFIX)
    || !canonicalWorkerProcessId(raw.workerProcessId)
    || !canonicalPrefixedSha256(raw.keyAnnouncementId, KEY_ANNOUNCEMENT_ID_PREFIX)
  ) {
    return null;
  }
  const publicKey = decodeCanonicalPublicKey(raw.publicKey);
  if (publicKey === null || raw.keyId !== `${KEY_ID_PREFIX}${sha256Hex(publicKey)}`) return null;
  const announcementMaterial = JSON.stringify([
    raw.schemaVersion,
    raw.algorithm,
    raw.keyId,
    raw.producer,
    raw.workerInstanceId,
    raw.workerProcessId,
    raw.publicKey,
  ]);
  if (
    raw.keyAnnouncementId
    !== `${KEY_ANNOUNCEMENT_ID_PREFIX}${sha256Hex(announcementMaterial)}`
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: raw.schemaVersion,
    algorithm: raw.algorithm,
    keyId: raw.keyId,
    producer: raw.producer,
    workerInstanceId: raw.workerInstanceId,
    workerProcessId: raw.workerProcessId,
    publicKey: raw.publicKey as string,
    keyAnnouncementId: raw.keyAnnouncementId,
  });
}

function dataChannelText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return null;
}

export class RuntimeEvidenceTransportKeyPin {
  private key: RuntimeEvidenceTransportVerificationKey | null = null;
  private failureReason: string | null = null;
  private disposed = false;
  private boundChannel: RTCDataChannel | null = null;
  private unbind: (() => void) | null = null;

  bindAuthenticatedPeerDataChannel(channel: RTCDataChannel): void {
    if (this.disposed) return;
    if (
      channel.label !== RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL
      || this.boundChannel !== null
    ) {
      this.fail("runtime_evidence_transport_authenticated_channel_invalid");
      return;
    }
    this.boundChannel = channel;
    const listener = (event: Event): void => {
      if (this.disposed || this.failureReason !== null) return;
      const text = dataChannelText((event as unknown as { data: unknown }).data);
      if (text === null) {
        this.fail("runtime_evidence_transport_key_announcement_encoding_invalid");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.fail("runtime_evidence_transport_key_announcement_json_invalid");
        return;
      }
      const next = parseRuntimeEvidenceTransportVerificationKey(parsed);
      if (next === null) {
        this.fail("runtime_evidence_transport_key_announcement_invalid");
        return;
      }
      if (this.key !== null && this.key.keyAnnouncementId !== next.keyAnnouncementId) {
        this.fail("runtime_evidence_transport_key_replaced_in_session");
        return;
      }
      this.key = next;
    };
    channel.addEventListener("message", listener);
    this.unbind = (): void => channel.removeEventListener("message", listener);
  }

  snapshot(): RuntimeEvidenceTransportKeyPinSnapshot {
    return Object.freeze({
      status: this.disposed
        ? "disposed"
        : this.failureReason !== null
          ? "failed"
          : this.key !== null
            ? "pinned"
            : "pending",
      key: this.key,
      failureReason: this.failureReason,
    });
  }

  dispose(): void {
    this.unbind?.();
    this.unbind = null;
    this.boundChannel = null;
    this.key = null;
    this.failureReason = null;
    this.disposed = true;
  }

  private fail(reason: string): void {
    this.key = null;
    this.failureReason ??= reason;
  }
}
