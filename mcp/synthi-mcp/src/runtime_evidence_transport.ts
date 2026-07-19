import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
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
const RECEIPT_SCHEMA = "synthi.gpu_hmr.runtime_evidence_transport_receipt.v2";
const RECEIPT_ID_PREFIX = "gpu-hmr-runtime-evidence-transport-receipt:sha256:";
const OBSERVED_ENVELOPE_SCHEMA = "synthi.gpu_hmr.observed_runtime_evidence_envelope.v2";
const OBSERVED_ENVELOPE_TYPE = "gpu_hmr_observed_runtime_evidence";
const OBSERVED_ENVELOPE_AUTHORITY =
  "worker_signed_observation_transport_only_not_gpu_hmr_acceptance";
const OBSERVATION_CONTEXT_DOMAIN =
  "synthi.gpu_hmr.runtime_evidence_transport_observation_context.v1";
const SUBJECT_IDENTITY_DOMAIN =
  "synthi.gpu_hmr.runtime_evidence_transport_subject_identity.v1";
const SIGNATURE_PREFIX = "ed25519:";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_RECEIPT_AGE_NS = 300_000_000_000n;
const MAX_FUTURE_SKEW_NS = 30_000_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const U128_MAX = 340_282_366_920_938_463_463_374_607_431_768_211_455n;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

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

export interface RuntimeEvidenceTransportSupportEnvelopeInput {
  readonly envelope: unknown;
  readonly observedPayload: Uint8Array | string;
  readonly runnerProcessId: number;
  readonly runtimeSessionId: string;
  readonly runnerChallenge: string;
  readonly transportSessionId: string;
  readonly requestId: string;
  readonly sourceEditId: string;
  readonly subjectIdentityNamespace: string;
  readonly subjectCanonicalBytes: Uint8Array | string;
  readonly artifactContentHash: string;
  readonly observedRuntimeProofId: string;
  readonly observedProofLedgerId: string;
}

export interface RuntimeEvidenceTransportSupportVerification {
  readonly verified: boolean;
  readonly reason: string | null;
  readonly receiptId: string | null;
  readonly observationContextHash: string | null;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface RuntimeEvidenceTransportReplayStore {
  consumeIfNewer(
    keyId: string,
    workerInstanceId: string,
    transportSessionBindingSha256: string,
    sequence: bigint,
    receiptId: string,
  ): string | null;
}

export class SessionRuntimeEvidenceTransportReplayStore
implements RuntimeEvidenceTransportReplayStore {
  private readonly replayStateByScope = new Map<
    string,
    Readonly<{ sequence: bigint; receiptId: string }>
  >();
  private disposed = false;

  consumeIfNewer(
    keyId: string,
    workerInstanceId: string,
    transportSessionBindingSha256: string,
    sequence: bigint,
    receiptId: string,
  ): string | null {
    if (this.disposed) return "runtime_evidence_transport_replay_store_disposed";
    const replayScope = [keyId, workerInstanceId, transportSessionBindingSha256].join("\0");
    const previous = this.replayStateByScope.get(replayScope);
    if (
      previous !== undefined
      && (sequence <= previous.sequence || receiptId === previous.receiptId)
    ) {
      return "runtime_evidence_transport_receipt_replayed";
    }
    this.replayStateByScope.set(replayScope, Object.freeze({ sequence, receiptId }));
    return null;
  }

  dispose(): void {
    this.replayStateByScope.clear();
    this.disposed = true;
  }
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

function canonicalSha256(value: unknown): value is string {
  return canonicalPrefixedSha256(value, "sha256:");
}

function canonicalToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[\x21-\x7e]+$/.test(value);
}

function canonicalDecimal(value: unknown, max: bigint): value is string {
  if (
    typeof value !== "string"
    || value.length > max.toString().length
    || !/^[1-9][0-9]*$/.test(value)
  ) return false;
  try {
    return BigInt(value) <= max;
  } catch {
    return false;
  }
}

function canonicalRuntimeProofId(value: unknown): value is string {
  return canonicalPrefixedSha256(value, "gpu-runtime-proof:sha256:");
}

function canonicalLedgerProofId(value: unknown): value is string {
  return canonicalPrefixedSha256(value, "gpu-ledger-proof:sha256:");
}

function canonicalRequestId(value: unknown): value is string {
  return typeof value === "string" && /^gpu-reload:request:[a-f0-9]{32}$/.test(value);
}

function canonicalSourceEditId(value: unknown): value is string {
  return canonicalPrefixedSha256(value, "source-edit:sha256:");
}

function decodeCanonicalBase64Url(value: unknown, byteLength: number): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== byteLength || decoded.toString("base64url") !== value) return null;
  return decoded;
}

function prefixedSha256(value: Uint8Array | string): string {
  return `sha256:${sha256Hex(value)}`;
}

function exactKeys(raw: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(raw);
  return keys.length === required.length
    && required.every((key) => Object.prototype.hasOwnProperty.call(raw, key));
}

function supportVerification(
  verified: boolean,
  reason: string | null,
  receiptId: string | null = null,
  observationContextHash: string | null = null,
): RuntimeEvidenceTransportSupportVerification {
  return Object.freeze({
    verified,
    reason,
    receiptId,
    observationContextHash,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
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
  private readonly listeners = new Set<
    (snapshot: RuntimeEvidenceTransportKeyPinSnapshot) => void
  >();
  private key: RuntimeEvidenceTransportVerificationKey | null = null;
  private failureReason: string | null = null;
  private disposed = false;
  private revision = 0;
  private boundChannel: RTCDataChannel | null = null;
  private unbind: (() => void) | null = null;

  bindAuthenticatedPeerDataChannel(channel: RTCDataChannel): void {
    if (this.disposed) return;
    if (
      channel.label !== RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL
      || this.boundChannel !== null
      || channel.readyState === "closing"
      || channel.readyState === "closed"
    ) {
      this.fail("runtime_evidence_transport_authenticated_channel_invalid");
      return;
    }
    this.boundChannel = channel;
    const messageListener = (event: Event): void => {
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
      if (this.key?.keyAnnouncementId === next.keyAnnouncementId) return;
      this.key = next;
      this.revision += 1;
      this.notifyChange();
    };
    const closeListener = (): void => {
      if (!this.disposed) {
        this.fail("runtime_evidence_transport_authenticated_channel_closed");
      }
    };
    channel.addEventListener("message", messageListener);
    channel.addEventListener("close", closeListener);
    this.unbind = (): void => {
      channel.removeEventListener("message", messageListener);
      channel.removeEventListener("close", closeListener);
    };
  }

  onChange(
    listener: (snapshot: RuntimeEvidenceTransportKeyPinSnapshot) => void,
  ): () => void {
    if (!this.disposed) this.listeners.add(listener);
    this.notifyListener(listener, this.snapshot());
    if (this.disposed) return () => {};
    return () => this.listeners.delete(listener);
  }

  waitUntilPinned(timeoutMs: number): Promise<RuntimeEvidenceTransportKeyPinSnapshot> {
    if (
      !Number.isFinite(timeoutMs)
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs <= 0
      || timeoutMs > MAX_TIMER_DELAY_MS
    ) {
      return Promise.reject(
        new Error("runtime_evidence_transport_key_pin_wait_timeout_invalid"),
      );
    }

    const current = this.snapshot();
    if (current.status === "pinned") return Promise.resolve(current);
    if (current.status === "failed") {
      return Promise.reject(new Error(
        current.failureReason ?? "runtime_evidence_transport_key_pin_failed",
      ));
    }
    if (current.status === "disposed") {
      return Promise.reject(new Error("runtime_evidence_transport_key_pin_disposed"));
    }

    return new Promise<RuntimeEvidenceTransportKeyPinSnapshot>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe: (() => void) | null = null;

      const cleanup = (): void => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (unsubscribe !== null) {
          const stopListening = unsubscribe;
          unsubscribe = null;
          stopListening();
        }
      };
      const settle = (completion: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        completion();
      };
      const observe = (snapshot: RuntimeEvidenceTransportKeyPinSnapshot): void => {
        if (snapshot.status === "pending") return;
        if (snapshot.status === "pinned") {
          settle(() => resolve(snapshot));
          return;
        }
        if (snapshot.status === "failed") {
          settle(() => reject(new Error(
            snapshot.failureReason ?? "runtime_evidence_transport_key_pin_failed",
          )));
          return;
        }
        settle(() => reject(new Error("runtime_evidence_transport_key_pin_disposed")));
      };

      unsubscribe = this.onChange(observe);
      if (settled) {
        cleanup();
        return;
      }
      timer = setTimeout(() => {
        settle(() => reject(
          new Error("runtime_evidence_transport_key_pin_wait_timeout"),
        ));
      }, timeoutMs);
      timer.unref?.();
    });
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
    if (this.disposed) return;
    this.unbind?.();
    this.unbind = null;
    this.boundChannel = null;
    this.key = null;
    this.failureReason = null;
    this.disposed = true;
    this.revision += 1;
    this.notifyChange();
    this.listeners.clear();
  }

  private fail(reason: string): void {
    if (this.failureReason !== null || this.disposed) return;
    this.key = null;
    this.failureReason = reason;
    this.revision += 1;
    this.notifyChange();
  }

  private notifyListener(
    listener: (snapshot: RuntimeEvidenceTransportKeyPinSnapshot) => void,
    snapshot: RuntimeEvidenceTransportKeyPinSnapshot,
  ): void {
    try {
      listener(snapshot);
    } catch {
      // One observer must not prevent other session safety observers from invalidating state.
    }
  }

  private notifyChange(): void {
    const notificationRevision = this.revision;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      if (this.revision !== notificationRevision) return;
      this.notifyListener(listener, snapshot);
    }
  }
}

const RECEIPT_KEYS = [
  "schemaVersion",
  "algorithm",
  "keyId",
  "producer",
  "workerInstanceId",
  "workerProcessId",
  "runnerProcessId",
  "runtimeSessionId",
  "runnerChallengeSha256",
  "transportSessionBindingSha256",
  "requestId",
  "sourceEditId",
  "subjectIdentityNamespace",
  "subjectIdentityHash",
  "artifactContentHash",
  "observedRuntimeProofId",
  "observedProofLedgerId",
  "observedPayloadSha256",
  "observationContextHash",
  "issuedAtUnixNs",
  "sequence",
  "nonce",
  "receiptId",
  "signature",
] as const;

const ENVELOPE_KEYS = [
  "schemaVersion",
  "type",
  "observedPayloadSha256",
  "runtimeEvidenceTransportReceipt",
  "proofAuthority",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const;

export class RuntimeEvidenceTransportReceiptConsumer {
  private disposed = false;

  constructor(
    private readonly keyPin: RuntimeEvidenceTransportKeyPin,
    private readonly replayStore: RuntimeEvidenceTransportReplayStore,
    private readonly clockUnixNs: () => bigint = () => BigInt(Date.now()) * 1_000_000n,
  ) {}

  consumeSupportEnvelope(
    input: RuntimeEvidenceTransportSupportEnvelopeInput,
  ): RuntimeEvidenceTransportSupportVerification {
    if (this.disposed) {
      return supportVerification(false, "runtime_evidence_transport_consumer_disposed");
    }
    const pin = this.keyPin.snapshot();
    if (pin.status !== "pinned" || pin.key === null) {
      return supportVerification(
        false,
        pin.failureReason ?? "runtime_evidence_transport_verification_key_not_pinned",
      );
    }
    const inputFailure = this.validateInput(input);
    if (inputFailure !== null) return supportVerification(false, inputFailure);

    const envelope = exactObject(input.envelope);
    if (envelope === null || !exactKeys(envelope, ENVELOPE_KEYS)) {
      return supportVerification(false, "observed_runtime_evidence_envelope_shape_invalid");
    }
    if (
      envelope.schemaVersion !== OBSERVED_ENVELOPE_SCHEMA
      || envelope.type !== OBSERVED_ENVELOPE_TYPE
      || envelope.proofAuthority !== OBSERVED_ENVELOPE_AUTHORITY
      || envelope.acceptedForGpuHmr !== false
      || envelope.gpuHmrSuccess !== false
      || envelope.canSatisfyRuntimeProof !== false
    ) {
      return supportVerification(false, "observed_runtime_evidence_envelope_shape_invalid");
    }

    const receipt = exactObject(envelope.runtimeEvidenceTransportReceipt);
    if (receipt === null || !exactKeys(receipt, RECEIPT_KEYS)) {
      return supportVerification(false, "runtime_evidence_transport_receipt_field_shape_invalid");
    }
    const shapeFailure = this.validateReceiptShape(receipt);
    if (shapeFailure !== null) return supportVerification(false, shapeFailure);

    const observedPayloadSha256 = prefixedSha256(input.observedPayload);
    if (
      envelope.observedPayloadSha256 !== observedPayloadSha256
      || receipt.observedPayloadSha256 !== observedPayloadSha256
    ) {
      return supportVerification(false, "runtime_evidence_transport_observed_payload_hash_mismatch");
    }

    const subjectCanonicalBytes = typeof input.subjectCanonicalBytes === "string"
      ? Buffer.from(input.subjectCanonicalBytes, "utf8")
      : Buffer.from(input.subjectCanonicalBytes);
    const subjectCanonicalBytesSha256 = prefixedSha256(subjectCanonicalBytes);
    const subjectIdentityHash = prefixedSha256(JSON.stringify([
      SUBJECT_IDENTITY_DOMAIN,
      input.subjectIdentityNamespace,
      subjectCanonicalBytesSha256,
    ]));
    const transportSessionBindingSha256 = prefixedSha256(
      `required\0${input.transportSessionId}`,
    );
    const runnerChallengeSha256 = prefixedSha256(input.runnerChallenge);
    const runnerProcessId = String(input.runnerProcessId);
    if (
      receipt.keyId !== pin.key.keyId
      || receipt.workerInstanceId !== pin.key.workerInstanceId
      || receipt.workerProcessId !== pin.key.workerProcessId
      || receipt.runnerProcessId !== runnerProcessId
      || receipt.runtimeSessionId !== input.runtimeSessionId
      || receipt.runnerChallengeSha256 !== runnerChallengeSha256
      || receipt.transportSessionBindingSha256 !== transportSessionBindingSha256
      || receipt.requestId !== input.requestId
      || receipt.sourceEditId !== input.sourceEditId
      || receipt.subjectIdentityNamespace !== input.subjectIdentityNamespace
      || receipt.subjectIdentityHash !== subjectIdentityHash
      || receipt.artifactContentHash !== input.artifactContentHash
      || receipt.observedRuntimeProofId !== input.observedRuntimeProofId
      || receipt.observedProofLedgerId !== input.observedProofLedgerId
    ) {
      return supportVerification(false, "runtime_evidence_transport_verification_context_mismatch");
    }

    const observationContextHash = prefixedSha256(JSON.stringify([
      OBSERVATION_CONTEXT_DOMAIN,
      pin.key.keyId,
      pin.key.workerInstanceId,
      pin.key.workerProcessId,
      runnerProcessId,
      input.runtimeSessionId,
      runnerChallengeSha256,
      transportSessionBindingSha256,
      input.requestId,
      input.sourceEditId,
      input.subjectIdentityNamespace,
      subjectIdentityHash,
      input.artifactContentHash,
      input.observedRuntimeProofId,
      input.observedProofLedgerId,
      observedPayloadSha256,
    ]));
    if (receipt.observationContextHash !== observationContextHash) {
      return supportVerification(
        false,
        "runtime_evidence_transport_verification_context_hash_mismatch",
      );
    }

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
    if (receipt.receiptId !== `${RECEIPT_ID_PREFIX}${sha256Hex(signingBytes)}`) {
      return supportVerification(false, "runtime_evidence_transport_receipt_id_mismatch");
    }
    const signature = decodeCanonicalBase64Url(
      (receipt.signature as string).slice(SIGNATURE_PREFIX.length),
      64,
    );
    const publicKeyBytes = decodeCanonicalPublicKey(pin.key.publicKey);
    if (signature === null || publicKeyBytes === null) {
      return supportVerification(false, "runtime_evidence_transport_signature_shape_invalid");
    }
    try {
      const publicKey = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
        format: "der",
        type: "spki",
      });
      if (!verifySignature(null, signingBytes, publicKey, signature)) {
        return supportVerification(false, "runtime_evidence_transport_signature_mismatch");
      }
    } catch {
      return supportVerification(false, "runtime_evidence_transport_signature_mismatch");
    }

    let nowUnixNs: bigint;
    try {
      nowUnixNs = this.clockUnixNs();
    } catch {
      return supportVerification(false, "runtime_evidence_transport_clock_failed");
    }
    if (nowUnixNs < 0n) {
      return supportVerification(false, "runtime_evidence_transport_clock_before_epoch");
    }
    const issuedAtUnixNs = BigInt(receipt.issuedAtUnixNs as string);
    if (issuedAtUnixNs > nowUnixNs + MAX_FUTURE_SKEW_NS) {
      return supportVerification(false, "runtime_evidence_transport_receipt_from_future");
    }
    if (issuedAtUnixNs <= nowUnixNs && nowUnixNs - issuedAtUnixNs > MAX_RECEIPT_AGE_NS) {
      return supportVerification(false, "runtime_evidence_transport_receipt_expired");
    }

    const sequence = BigInt(receipt.sequence as string);
    const replayFailure = this.replayStore.consumeIfNewer(
      receipt.keyId as string,
      receipt.workerInstanceId as string,
      receipt.transportSessionBindingSha256 as string,
      sequence,
      receipt.receiptId as string,
    );
    if (replayFailure !== null) return supportVerification(false, replayFailure);
    return supportVerification(
      true,
      null,
      receipt.receiptId as string,
      observationContextHash,
    );
  }

  dispose(): void {
    this.disposed = true;
  }

  private validateInput(input: RuntimeEvidenceTransportSupportEnvelopeInput): string | null {
    const subjectByteLength = typeof input.subjectCanonicalBytes === "string"
      ? Buffer.byteLength(input.subjectCanonicalBytes, "utf8")
      : input.subjectCanonicalBytes.byteLength;
    if (
      !Number.isSafeInteger(input.runnerProcessId)
      || input.runnerProcessId < 1
      || input.runnerProcessId > 0xffff_ffff
      || !canonicalToken(input.runtimeSessionId)
      || !/^[a-f0-9]{32}$/.test(input.runnerChallenge)
      || !canonicalToken(input.transportSessionId)
      || !canonicalRequestId(input.requestId)
      || !canonicalSourceEditId(input.sourceEditId)
      || !canonicalToken(input.subjectIdentityNamespace)
      || subjectByteLength === 0
      || !canonicalSha256(input.artifactContentHash)
      || !canonicalRuntimeProofId(input.observedRuntimeProofId)
      || !canonicalLedgerProofId(input.observedProofLedgerId)
      || (typeof input.observedPayload === "string"
        ? Buffer.byteLength(input.observedPayload, "utf8") === 0
        : input.observedPayload.byteLength === 0)
    ) {
      return "runtime_evidence_transport_verification_context_invalid";
    }
    return null;
  }

  private validateReceiptShape(receipt: Record<string, unknown>): string | null {
    const signature = typeof receipt.signature === "string"
      ? receipt.signature.slice(SIGNATURE_PREFIX.length)
      : null;
    if (
      receipt.schemaVersion !== RECEIPT_SCHEMA
      || receipt.algorithm !== RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM
      || receipt.producer !== RUNTIME_EVIDENCE_TRANSPORT_PRODUCER
      || !canonicalPrefixedSha256(receipt.keyId, KEY_ID_PREFIX)
      || !canonicalPrefixedSha256(receipt.workerInstanceId, WORKER_INSTANCE_ID_PREFIX)
      || !canonicalWorkerProcessId(receipt.workerProcessId)
      || !canonicalWorkerProcessId(receipt.runnerProcessId)
      || !canonicalToken(receipt.runtimeSessionId)
      || !canonicalSha256(receipt.runnerChallengeSha256)
      || !canonicalSha256(receipt.transportSessionBindingSha256)
      || !canonicalRequestId(receipt.requestId)
      || !canonicalSourceEditId(receipt.sourceEditId)
      || !canonicalToken(receipt.subjectIdentityNamespace)
      || !canonicalSha256(receipt.subjectIdentityHash)
      || !canonicalSha256(receipt.artifactContentHash)
      || !canonicalRuntimeProofId(receipt.observedRuntimeProofId)
      || !canonicalLedgerProofId(receipt.observedProofLedgerId)
      || !canonicalSha256(receipt.observedPayloadSha256)
      || !canonicalSha256(receipt.observationContextHash)
      || !canonicalDecimal(receipt.issuedAtUnixNs, U128_MAX)
      || !canonicalDecimal(receipt.sequence, U64_MAX)
      || typeof receipt.nonce !== "string"
      || !/^[a-f0-9]{64}$/.test(receipt.nonce)
      || !canonicalPrefixedSha256(receipt.receiptId, RECEIPT_ID_PREFIX)
      || typeof receipt.signature !== "string"
      || !receipt.signature.startsWith(SIGNATURE_PREFIX)
      || decodeCanonicalBase64Url(signature, 64) === null
    ) {
      return "runtime_evidence_transport_receipt_field_shape_invalid";
    }
    return null;
  }
}
