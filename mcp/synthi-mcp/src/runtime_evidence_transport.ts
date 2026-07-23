import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";
import type { RTCDataChannel } from "werift";
import * as sharedRuntimeEvidenceTransportVerifierModule
  from "../scripts/lib/gpu-hmr-runtime-evidence-transport-offline-verifier.mjs";

const sharedRuntimeEvidenceTransportVerifier =
  sharedRuntimeEvidenceTransportVerifierModule as unknown as Readonly<{
    RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM: "ed25519";
    RUNTIME_EVIDENCE_TRANSPORT_PRODUCER: "synthi-webrtc-compiler-worker";
    RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA:
      "synthi.gpu_hmr.runtime_evidence_transport_verification_key.v1";
    parseRuntimeEvidenceTransportVerificationKey: (value: unknown) => unknown;
    verifyRuntimeEvidenceTransportSupportEnvelopeCryptographicCore:
      (key: unknown, envelope: unknown, payload: unknown, context: unknown) => unknown;
    verifyRuntimeEvidenceTransportSupportEnvelopeOffline:
      (key: unknown, envelope: unknown, payload: unknown, context: unknown) => unknown;
  }>;

export const RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL =
  "gpu-hmr-evidence-transport";
export const RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA:
  "synthi.gpu_hmr.runtime_evidence_transport_verification_key.v1" =
    sharedRuntimeEvidenceTransportVerifier.RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA;
export const RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM: "ed25519" =
  sharedRuntimeEvidenceTransportVerifier.RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM;

const RUNTIME_EVIDENCE_TRANSPORT_PRODUCER:
  "synthi-webrtc-compiler-worker" =
    sharedRuntimeEvidenceTransportVerifier.RUNTIME_EVIDENCE_TRANSPORT_PRODUCER;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_RECEIPT_AGE_NS = 300_000_000_000n;
const MAX_FUTURE_SKEW_NS = 30_000_000_000n;
const MAX_PENDING_PREPARED_SUPPORT_ENVELOPES = 256;
const MAX_RETAINED_CALLER_PREPARED_SUPPORT_ENVELOPES =
  MAX_PENDING_PREPARED_SUPPORT_ENVELOPES - 1;
const PREPARED_SUPPORT_ENVELOPE_TTL_NS = 30_000_000_000n;
const SUPPORT_PREPARATION_SCHEMA =
  "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1" as const;
const SUPPORT_PREPARATION_AUTHORITY =
  "cryptographic_and_freshness_preparation_only_replay_not_committed" as const;
const OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_SCHEMA =
  "synthi.gpu_hmr.observed_runtime_evidence_envelope.v2" as const;
const OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_TYPE =
  "gpu_hmr_observed_runtime_evidence" as const;
const OBSERVED_RUNTIME_EVIDENCE_AUTHORITY =
  "worker_signed_observation_transport_only_not_gpu_hmr_acceptance" as const;
export const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_SCHEMA =
  "synthi.gpu_hmr.observed_runtime_evidence_delivery.v1" as const;
export const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_TYPE =
  "gpu_hmr_observed_runtime_evidence_delivery" as const;
export const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_ENCODING =
  "base64url_no_pad" as const;
export const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_AUTHORITY =
  "worker_payload_delivery_only_not_gpu_hmr_acceptance" as const;
export const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_PAYLOAD_BYTES = 512 * 1024;
const DEFAULT_ROUTER_RETAINED_OBSERVED_DELIVERY_CAPACITY = 64;
export const RUNTIME_EVIDENCE_TRANSPORT_MAX_MESSAGE_BYTES = 1_048_576;
const DEFAULT_ROUTER_MAX_RETAINED_OBSERVED_DELIVERY_BYTES = 4_194_304;
const ROUTER_LIMIT_KEYS = [
  "maxRetainedObservedDeliveryCount",
  "maxMessageBytes",
  "maxRetainedObservedDeliveryBytes",
] as const;
const OBSERVED_RUNTIME_EVIDENCE_DELIVERY_KEYS = [
  "schemaVersion",
  "type",
  "observedPayloadEncoding",
  "observedPayloadByteLength",
  "observedPayloadBase64",
  "runtimeEvidenceTransportEnvelope",
  "proofAuthority",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const;

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

export interface RuntimeEvidenceTransportVerificationContext {
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

export interface RuntimeEvidenceTransportSupportEnvelopeInput
extends RuntimeEvidenceTransportVerificationContext {
  readonly envelope: unknown;
  readonly observedPayload: Uint8Array | string;
}

export interface RuntimeEvidenceTransportObservedDelivery {
  readonly schemaVersion: typeof OBSERVED_RUNTIME_EVIDENCE_DELIVERY_SCHEMA;
  readonly type: typeof OBSERVED_RUNTIME_EVIDENCE_DELIVERY_TYPE;
  readonly observedPayloadSha256: string;
  readonly serializedDelivery: string;
  readonly proofAuthority: typeof OBSERVED_RUNTIME_EVIDENCE_DELIVERY_AUTHORITY;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

interface RuntimeEvidenceTransportObservedDeliveryBinding {
  readonly envelope: Readonly<Record<string, unknown>>;
}

const observedDeliveryBindings = new WeakMap<
  RuntimeEvidenceTransportObservedDelivery,
  RuntimeEvidenceTransportObservedDeliveryBinding
>();

export function observedRuntimeEvidenceDeliveryMatchesEnvelope(
  delivery: RuntimeEvidenceTransportObservedDelivery,
  envelope: unknown,
): boolean {
  const binding = observedDeliveryBindings.get(delivery);
  const candidate = plainRecord(envelope);
  if (
    binding === undefined
    || candidate === null
    || candidate.observedPayloadSha256 !== delivery.observedPayloadSha256
  ) {
    return false;
  }
  try {
    return isDeepStrictEqual(binding.envelope, candidate);
  } catch {
    return false;
  }
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

export interface RuntimeEvidenceTransportPreparedSupportEnvelope {
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface RuntimeEvidenceTransportSupportPreparation {
  readonly schemaVersion: typeof SUPPORT_PREPARATION_SCHEMA;
  readonly proofAuthority: typeof SUPPORT_PREPARATION_AUTHORITY;
  readonly prepared: boolean;
  readonly reason: string | null;
  readonly capability: RuntimeEvidenceTransportPreparedSupportEnvelope | null;
  readonly receiptId: string | null;
  readonly observationContextHash: string | null;
  readonly freshnessChecked: boolean;
  readonly replayChecked: false;
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

interface RuntimeEvidenceTransportOnlinePolicy {
  readonly issuedAtUnixNs: bigint;
  readonly sequence: bigint;
  readonly keyId: string;
  readonly workerInstanceId: string;
  readonly transportSessionBindingSha256: string;
  readonly receiptId: string;
}

interface RuntimeEvidenceTransportSharedCoreResult {
  readonly verification: RuntimeEvidenceTransportSupportVerification;
  readonly onlinePolicy: RuntimeEvidenceTransportOnlinePolicy | null;
}

interface RuntimeEvidenceTransportVerificationKeyIdentity {
  readonly schemaVersion: typeof RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA;
  readonly algorithm: typeof RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM;
  readonly keyId: string;
  readonly producer: typeof RUNTIME_EVIDENCE_TRANSPORT_PRODUCER;
  readonly workerInstanceId: string;
  readonly workerProcessId: string;
  readonly publicKey: string;
  readonly keyAnnouncementId: string;
}

interface RuntimeEvidenceTransportPreparedState {
  readonly verification: RuntimeEvidenceTransportSupportVerification;
  readonly onlinePolicy: RuntimeEvidenceTransportOnlinePolicy;
  readonly keyIdentity: RuntimeEvidenceTransportVerificationKeyIdentity;
  readonly expiresAtUnixNs: bigint;
}

interface RuntimeEvidenceTransportSupportEnvelopeInputSnapshot {
  readonly envelope: unknown;
  readonly observedPayload: Uint8Array | string;
  readonly context: RuntimeEvidenceTransportVerificationContext;
}

const SUPPORT_ENVELOPE_INPUT_KEYS = [
  "envelope",
  "observedPayload",
  "runnerProcessId",
  "runtimeSessionId",
  "runnerChallenge",
  "transportSessionId",
  "requestId",
  "sourceEditId",
  "subjectIdentityNamespace",
  "subjectCanonicalBytes",
  "artifactContentHash",
  "observedRuntimeProofId",
  "observedProofLedgerId",
] as const;

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

function supportPreparation(
  prepared: boolean,
  reason: string | null,
  capability: RuntimeEvidenceTransportPreparedSupportEnvelope | null,
  receiptId: string | null = null,
  observationContextHash: string | null = null,
  freshnessChecked = false,
): RuntimeEvidenceTransportSupportPreparation {
  return Object.freeze({
    schemaVersion: SUPPORT_PREPARATION_SCHEMA,
    proofAuthority: SUPPORT_PREPARATION_AUTHORITY,
    prepared,
    reason,
    capability,
    receiptId,
    observationContextHash,
    freshnessChecked,
    replayChecked: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function preparedSupportEnvelopeCapability(): RuntimeEvidenceTransportPreparedSupportEnvelope {
  return Object.freeze({
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function verificationKeyIdentity(
  key: RuntimeEvidenceTransportVerificationKey,
): RuntimeEvidenceTransportVerificationKeyIdentity | null {
  try {
    const parsed = parseRuntimeEvidenceTransportVerificationKey(key);
    if (parsed === null) return null;
    return Object.freeze({
      schemaVersion: parsed.schemaVersion,
      algorithm: parsed.algorithm,
      keyId: parsed.keyId,
      producer: parsed.producer,
      workerInstanceId: parsed.workerInstanceId,
      workerProcessId: parsed.workerProcessId,
      publicKey: parsed.publicKey,
      keyAnnouncementId: parsed.keyAnnouncementId,
    });
  } catch {
    return null;
  }
}

function sameVerificationKeyIdentity(
  left: RuntimeEvidenceTransportVerificationKeyIdentity,
  right: RuntimeEvidenceTransportVerificationKeyIdentity,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.algorithm === right.algorithm
    && left.keyId === right.keyId
    && left.producer === right.producer
    && left.workerInstanceId === right.workerInstanceId
    && left.workerProcessId === right.workerProcessId
    && left.publicKey === right.publicKey
    && left.keyAnnouncementId === right.keyAnnouncementId;
}

export function parseRuntimeEvidenceTransportVerificationKey(
  value: unknown,
): RuntimeEvidenceTransportVerificationKey | null {
  return sharedRuntimeEvidenceTransportVerifier
    .parseRuntimeEvidenceTransportVerificationKey(value) as
    RuntimeEvidenceTransportVerificationKey | null;
}

export function verifyRuntimeEvidenceTransportSupportEnvelopeOffline(
  verificationKey: RuntimeEvidenceTransportVerificationKey,
  envelope: unknown,
  observedPayload: Uint8Array | string,
  context: RuntimeEvidenceTransportVerificationContext,
): RuntimeEvidenceTransportSupportVerification {
  return sharedRuntimeEvidenceTransportVerifier
    .verifyRuntimeEvidenceTransportSupportEnvelopeOffline(
      verificationKey,
      envelope,
      observedPayload,
      context,
    ) as RuntimeEvidenceTransportSupportVerification;
}

function snapshotSupportEnvelopeInput(
  input: RuntimeEvidenceTransportSupportEnvelopeInput,
): RuntimeEvidenceTransportSupportEnvelopeInputSnapshot | null {
  try {
    if (input === null || typeof input !== "object" || isProxy(input)) return null;
    if (Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(input);
    if (ownKeys.length !== SUPPORT_ENVELOPE_INPUT_KEYS.length) return null;
    const requiredKeySet = new Set<string>(SUPPORT_ENVELOPE_INPUT_KEYS);
    if (ownKeys.some((key) => typeof key !== "string" || !requiredKeySet.has(key))) {
      return null;
    }

    const values: Record<string, unknown> = {};
    for (const key of SUPPORT_ENVELOPE_INPUT_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")
        || Object.prototype.hasOwnProperty.call(descriptor, "get")
        || Object.prototype.hasOwnProperty.call(descriptor, "set")
      ) {
        return null;
      }
      Object.defineProperty(values, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    Object.freeze(values);
    const context: RuntimeEvidenceTransportVerificationContext = Object.freeze({
      runnerProcessId: values.runnerProcessId as number,
      runtimeSessionId: values.runtimeSessionId as string,
      runnerChallenge: values.runnerChallenge as string,
      transportSessionId: values.transportSessionId as string,
      requestId: values.requestId as string,
      sourceEditId: values.sourceEditId as string,
      subjectIdentityNamespace: values.subjectIdentityNamespace as string,
      subjectCanonicalBytes: values.subjectCanonicalBytes as Uint8Array | string,
      artifactContentHash: values.artifactContentHash as string,
      observedRuntimeProofId: values.observedRuntimeProofId as string,
      observedProofLedgerId: values.observedProofLedgerId as string,
    });
    return Object.freeze({
      envelope: values.envelope,
      observedPayload: values.observedPayload as Uint8Array | string,
      context,
    });
  } catch {
    return null;
  }
}

function verifyRuntimeEvidenceTransportSupportEnvelopeCryptographicCore(
  verificationKey: RuntimeEvidenceTransportVerificationKey,
  envelope: unknown,
  observedPayload: Uint8Array | string,
  context: RuntimeEvidenceTransportVerificationContext,
): RuntimeEvidenceTransportSharedCoreResult {
  return sharedRuntimeEvidenceTransportVerifier
    .verifyRuntimeEvidenceTransportSupportEnvelopeCryptographicCore(
      verificationKey,
      envelope,
      observedPayload,
      context,
    ) as RuntimeEvidenceTransportSharedCoreResult;
}

interface DataChannelText {
  readonly text: string;
  readonly byteLength: number;
}

function dataChannelText(data: unknown): DataChannelText | null {
  if (typeof data === "string") {
    return Object.freeze({ text: data, byteLength: Buffer.byteLength(data, "utf8") });
  }
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    return null;
  }
  try {
    return Object.freeze({
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      byteLength: bytes.byteLength,
    });
  } catch {
    return null;
  }
}

function binaryDataChannelByteLength(data: unknown): number | null {
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return null;
}

interface ObservedRuntimeEvidenceDeliveryParseResult {
  readonly delivery: RuntimeEvidenceTransportObservedDelivery | null;
  readonly reason: string | null;
}

function deliveryParseFailure(reason: string): ObservedRuntimeEvidenceDeliveryParseResult {
  return Object.freeze({ delivery: null, reason });
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (
    value === null
    || typeof value !== "object"
    || isProxy(value)
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  return keys.every((key) => typeof key === "string" && expected.has(key));
}

function canonicalSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function expectedBase64urlNoPadLength(byteLength: number): number {
  const remainder = byteLength % 3;
  return Math.floor(byteLength / 3) * 4 + (remainder === 0 ? 0 : remainder + 1);
}

function parseObservedRuntimeEvidenceDelivery(
  value: unknown,
  serializedDelivery: string,
): ObservedRuntimeEvidenceDeliveryParseResult {
  const record = plainRecord(value);
  if (
    record === null
    || !hasExactOwnKeys(record, OBSERVED_RUNTIME_EVIDENCE_DELIVERY_KEYS)
    || record.schemaVersion !== OBSERVED_RUNTIME_EVIDENCE_DELIVERY_SCHEMA
    || record.type !== OBSERVED_RUNTIME_EVIDENCE_DELIVERY_TYPE
    || record.observedPayloadEncoding !== OBSERVED_RUNTIME_EVIDENCE_DELIVERY_ENCODING
    || record.proofAuthority !== OBSERVED_RUNTIME_EVIDENCE_DELIVERY_AUTHORITY
    || record.acceptedForGpuHmr !== false
    || record.gpuHmrSuccess !== false
    || record.canSatisfyRuntimeProof !== false
    || typeof record.observedPayloadByteLength !== "string"
    || !/^[1-9][0-9]*$/.test(record.observedPayloadByteLength)
    || typeof record.observedPayloadBase64 !== "string"
  ) {
    return deliveryParseFailure("observed_runtime_evidence_delivery_shape_invalid");
  }

  const maximumByteLength = String(
    OBSERVED_RUNTIME_EVIDENCE_DELIVERY_MAX_PAYLOAD_BYTES,
  );
  if (
    record.observedPayloadByteLength.length > maximumByteLength.length
    || (
      record.observedPayloadByteLength.length === maximumByteLength.length
      && record.observedPayloadByteLength > maximumByteLength
    )
  ) {
    return deliveryParseFailure(
      "observed_runtime_evidence_delivery_payload_too_large",
    );
  }
  const observedPayloadByteLength = Number(record.observedPayloadByteLength);
  if (
    !Number.isSafeInteger(observedPayloadByteLength)
    || observedPayloadByteLength <= 0
  ) {
    return deliveryParseFailure("observed_runtime_evidence_delivery_shape_invalid");
  }
  if (
    record.observedPayloadBase64.length
    !== expectedBase64urlNoPadLength(observedPayloadByteLength)
  ) {
    return deliveryParseFailure(
      "observed_runtime_evidence_delivery_payload_encoding_invalid",
    );
  }

  let observedPayload: Buffer;
  try {
    observedPayload = Buffer.from(record.observedPayloadBase64, "base64url");
  } catch {
    return deliveryParseFailure(
      "observed_runtime_evidence_delivery_payload_encoding_invalid",
    );
  }
  if (
    observedPayload.byteLength !== observedPayloadByteLength
    || observedPayload.toString("base64url") !== record.observedPayloadBase64
  ) {
    return deliveryParseFailure(
      "observed_runtime_evidence_delivery_payload_encoding_invalid",
    );
  }

  const envelope = plainRecord(record.runtimeEvidenceTransportEnvelope);
  if (
    envelope === null
    || envelope.schemaVersion !== OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_SCHEMA
    || envelope.type !== OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_TYPE
    || envelope.proofAuthority !== OBSERVED_RUNTIME_EVIDENCE_AUTHORITY
    || envelope.acceptedForGpuHmr !== false
    || envelope.gpuHmrSuccess !== false
    || envelope.canSatisfyRuntimeProof !== false
    || !canonicalSha256(envelope.observedPayloadSha256)
  ) {
    return deliveryParseFailure("observed_runtime_evidence_envelope_shape_invalid");
  }

  const observedPayloadSha256 = `sha256:${
    createHash("sha256").update(observedPayload).digest("hex")
  }`;
  if (observedPayloadSha256 !== envelope.observedPayloadSha256) {
    return deliveryParseFailure(
      "observed_runtime_evidence_delivery_payload_envelope_hash_mismatch",
    );
  }

  const delivery = Object.freeze({
    schemaVersion: OBSERVED_RUNTIME_EVIDENCE_DELIVERY_SCHEMA,
    type: OBSERVED_RUNTIME_EVIDENCE_DELIVERY_TYPE,
    observedPayloadSha256,
    serializedDelivery,
    proofAuthority: OBSERVED_RUNTIME_EVIDENCE_DELIVERY_AUTHORITY,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
  observedDeliveryBindings.set(delivery, Object.freeze({ envelope }));
  return Object.freeze({
    delivery,
    reason: null,
  });
}

const keyPinAnnouncementIngress = new WeakMap<
  RuntimeEvidenceTransportKeyPin,
  (value: unknown) => void
>();
const keyPinOwnership = new WeakMap<RuntimeEvidenceTransportKeyPin, object>();
const directKeyPinOwner = {};

function claimKeyPinOwnership(
  keyPin: RuntimeEvidenceTransportKeyPin,
  owner: object,
): boolean {
  if (keyPinOwnership.has(keyPin)) return false;
  keyPinOwnership.set(keyPin, owner);
  return true;
}

function releaseKeyPinOwnership(keyPin: RuntimeEvidenceTransportKeyPin): void {
  keyPinOwnership.delete(keyPin);
}

function routeVerificationKeyAnnouncement(
  keyPin: RuntimeEvidenceTransportKeyPin,
  value: unknown,
): void {
  keyPinAnnouncementIngress.get(keyPin)?.(value);
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

  constructor() {
    keyPinAnnouncementIngress.set(this, (value) => this.acceptVerificationKeyAnnouncement(value));
  }

  bindAuthenticatedPeerDataChannel(channel: RTCDataChannel): boolean {
    if (this.disposed) return false;
    if (keyPinOwnership.has(this)) return false;
    if (
      channel.label !== RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL
      || this.boundChannel !== null
      || channel.readyState === "closing"
      || channel.readyState === "closed"
    ) {
      this.fail("runtime_evidence_transport_authenticated_channel_invalid");
      return false;
    }
    if (!claimKeyPinOwnership(this, directKeyPinOwner)) return false;
    this.boundChannel = channel;
    const messageListener = (event: Event): void => {
      if (this.disposed || this.failureReason !== null) return;
      const data = (event as unknown as { data: unknown }).data;
      const binaryByteLength = binaryDataChannelByteLength(data);
      if (
        binaryByteLength !== null
        && binaryByteLength > RUNTIME_EVIDENCE_TRANSPORT_MAX_MESSAGE_BYTES
      ) {
        this.fail("runtime_evidence_transport_key_announcement_byte_limit_exceeded");
        return;
      }
      const text = dataChannelText(data);
      if (text === null) {
        this.fail("runtime_evidence_transport_key_announcement_encoding_invalid");
        return;
      }
      if (text.byteLength > RUNTIME_EVIDENCE_TRANSPORT_MAX_MESSAGE_BYTES) {
        this.fail("runtime_evidence_transport_key_announcement_byte_limit_exceeded");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.text);
      } catch {
        this.fail("runtime_evidence_transport_key_announcement_json_invalid");
        return;
      }
      this.acceptVerificationKeyAnnouncement(parsed);
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
    return true;
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
    releaseKeyPinOwnership(this);
    this.key = null;
    this.failureReason = null;
    this.disposed = true;
    this.revision += 1;
    this.notifyChange();
    this.listeners.clear();
  }

  private fail(reason: string): void {
    if (this.failureReason !== null || this.disposed) return;
    this.unbind?.();
    this.unbind = null;
    this.boundChannel = null;
    this.key = null;
    this.failureReason = reason;
    this.revision += 1;
    this.notifyChange();
  }

  private acceptVerificationKeyAnnouncement(value: unknown): void {
    if (this.disposed || this.failureReason !== null) return;
    const next = parseRuntimeEvidenceTransportVerificationKey(value);
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

export interface RuntimeEvidenceTransportChannelRouterSnapshot {
  readonly status: "pending" | "active" | "failed" | "disposed";
  readonly failureReason: string | null;
  readonly retainedObservedDeliveryCount: number;
  readonly retainedObservedDeliveryBytes: number;
}

export interface RuntimeEvidenceTransportChannelRouterLimits {
  readonly maxRetainedObservedDeliveryCount?: number;
  readonly maxMessageBytes?: number;
  readonly maxRetainedObservedDeliveryBytes?: number;
}

export type RuntimeEvidenceTransportObservedDeliveryListener = (
  delivery: RuntimeEvidenceTransportObservedDelivery,
) => void;

export type RuntimeEvidenceTransportChannelRouterListener = (
  snapshot: RuntimeEvidenceTransportChannelRouterSnapshot,
) => void;

/**
 * Routes authenticated-channel records by their versioned discriminator only.
 * Signature, context, freshness, and replay validation remain the consumer's responsibility.
 */
export class RuntimeEvidenceTransportChannelRouter {
  private readonly listeners = new Set<RuntimeEvidenceTransportObservedDeliveryListener>();
  private readonly statusListeners =
    new Set<RuntimeEvidenceTransportChannelRouterListener>();
  private readonly retainedObservedDeliveries: RuntimeEvidenceTransportObservedDelivery[] = [];
  private readonly ownershipToken = {};
  private readonly retainedObservedDeliveryCapacity: number;
  private readonly maxMessageBytes: number;
  private readonly maxRetainedObservedDeliveryBytes: number;
  private retainedObservedDeliveryBytes = 0;
  private boundChannel: RTCDataChannel | null = null;
  private unbind: (() => void) | null = null;
  private unsubscribeKeyPin: (() => void) | null = null;
  private failureReason: string | null = null;
  private disposed = false;
  private ownsKeyPin = false;
  private disposingOwnedKeyPin = false;

  constructor(
    private readonly keyPin: RuntimeEvidenceTransportKeyPin,
    limits: RuntimeEvidenceTransportChannelRouterLimits = {},
  ) {
    const normalizedLimits = this.normalizeLimits(limits);
    this.retainedObservedDeliveryCapacity =
      normalizedLimits.maxRetainedObservedDeliveryCount;
    this.maxMessageBytes = normalizedLimits.maxMessageBytes;
    this.maxRetainedObservedDeliveryBytes =
      normalizedLimits.maxRetainedObservedDeliveryBytes;
    const keyPinSnapshot = this.keyPin.snapshot();
    if (keyPinSnapshot.status === "failed") {
      this.failureReason = keyPinSnapshot.failureReason
        ?? "runtime_evidence_transport_router_key_pin_failed";
      return;
    }
    if (keyPinSnapshot.status === "disposed") {
      this.failureReason = "runtime_evidence_transport_router_key_pin_disposed";
      return;
    }
    if (!claimKeyPinOwnership(this.keyPin, this.ownershipToken)) {
      this.failureReason = "runtime_evidence_transport_router_key_pin_ownership_unavailable";
      return;
    }
    this.ownsKeyPin = true;
    const unsubscribeKeyPin = this.keyPin.onChange((snapshot) => {
      if (this.disposed || this.disposingOwnedKeyPin) return;
      if (snapshot.status === "failed") {
        this.fail(
          snapshot.failureReason ?? "runtime_evidence_transport_router_key_pin_failed",
        );
      } else if (snapshot.status === "disposed") {
        this.fail("runtime_evidence_transport_router_key_pin_disposed");
      }
    });
    if (this.failureReason !== null || this.disposed) {
      unsubscribeKeyPin();
    } else {
      this.unsubscribeKeyPin = unsubscribeKeyPin;
    }
  }

  bindAuthenticatedPeerDataChannel(channel: RTCDataChannel): void {
    if (this.disposed || this.failureReason !== null) return;
    if (
      channel.label !== RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL
      || this.boundChannel !== null
      || channel.readyState === "closing"
      || channel.readyState === "closed"
    ) {
      this.fail("runtime_evidence_transport_router_authenticated_channel_invalid");
      return;
    }
    this.boundChannel = channel;
    const messageListener = (event: Event): void => {
      this.routeMessage((event as unknown as { data: unknown }).data);
    };
    const closeListener = (): void => {
      if (this.disposed) return;
      this.fail("runtime_evidence_transport_router_authenticated_channel_closed");
      this.disposeOwnedKeyPin();
    };
    channel.addEventListener("message", messageListener);
    channel.addEventListener("close", closeListener);
    this.unbind = (): void => {
      channel.removeEventListener("message", messageListener);
      channel.removeEventListener("close", closeListener);
    };
    this.notifyStatusChange();
  }

  onObservedDelivery(
    listener: RuntimeEvidenceTransportObservedDeliveryListener,
  ): () => void {
    if (this.disposed || this.failureReason !== null) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onChange(
    listener: RuntimeEvidenceTransportChannelRouterListener,
  ): () => void {
    if (!this.disposed && this.failureReason === null) {
      this.statusListeners.add(listener);
    }
    this.notifyStatusListener(listener, this.snapshot());
    if (this.disposed || this.failureReason !== null) return () => {};
    return () => this.statusListeners.delete(listener);
  }

  drainObservedDeliveries(): readonly RuntimeEvidenceTransportObservedDelivery[] {
    const drained = Object.freeze([...this.retainedObservedDeliveries]);
    this.retainedObservedDeliveries.length = 0;
    this.retainedObservedDeliveryBytes = 0;
    return drained;
  }

  snapshot(): RuntimeEvidenceTransportChannelRouterSnapshot {
    return Object.freeze({
      status: this.disposed
        ? "disposed"
        : this.failureReason !== null
          ? "failed"
          : this.boundChannel !== null
            ? "active"
            : "pending",
      failureReason: this.failureReason,
      retainedObservedDeliveryCount: this.retainedObservedDeliveries.length,
      retainedObservedDeliveryBytes: this.retainedObservedDeliveryBytes,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.unbind?.();
    this.unbind = null;
    this.unsubscribeKeyPin?.();
    this.unsubscribeKeyPin = null;
    this.boundChannel = null;
    this.retainedObservedDeliveries.length = 0;
    this.retainedObservedDeliveryBytes = 0;
    this.listeners.clear();
    this.disposed = true;
    this.notifyStatusChange();
    this.statusListeners.clear();
    this.disposeOwnedKeyPin();
  }

  private routeMessage(data: unknown): void {
    if (this.disposed || this.failureReason !== null) return;
    const binaryByteLength = binaryDataChannelByteLength(data);
    if (binaryByteLength !== null && binaryByteLength > this.maxMessageBytes) {
      this.fail("runtime_evidence_transport_router_message_byte_limit_exceeded");
      return;
    }
    const text = dataChannelText(data);
    if (text === null) {
      this.fail("runtime_evidence_transport_router_message_encoding_invalid");
      return;
    }
    if (text.byteLength > this.maxMessageBytes) {
      this.fail("runtime_evidence_transport_router_message_byte_limit_exceeded");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      this.fail("runtime_evidence_transport_router_message_json_invalid");
      return;
    }
    if (
      parsed === null
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      this.fail("runtime_evidence_transport_router_message_shape_invalid");
      return;
    }

    const schemaVersion = (parsed as Record<string, unknown>).schemaVersion;
    if (schemaVersion === RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA) {
      routeVerificationKeyAnnouncement(this.keyPin, parsed);
      const keyPinSnapshot = this.keyPin.snapshot();
      if (keyPinSnapshot.status === "failed") {
        this.fail(
          keyPinSnapshot.failureReason
          ?? "runtime_evidence_transport_router_key_pin_failed",
        );
      } else if (keyPinSnapshot.status === "disposed") {
        this.fail("runtime_evidence_transport_router_key_pin_disposed");
      }
      return;
    }

    if (schemaVersion === OBSERVED_RUNTIME_EVIDENCE_DELIVERY_SCHEMA) {
      if (
        (parsed as Record<string, unknown>).type
        !== OBSERVED_RUNTIME_EVIDENCE_DELIVERY_TYPE
      ) {
        this.fail("runtime_evidence_transport_router_message_type_unknown");
        return;
      }
      if (this.keyPin.snapshot().status !== "pinned") {
        this.fail("runtime_evidence_transport_router_observed_delivery_before_key");
        return;
      }
      const deliveryResult = parseObservedRuntimeEvidenceDelivery(parsed, text.text);
      if (deliveryResult.delivery === null) {
        this.fail(
          deliveryResult.reason
          ?? "observed_runtime_evidence_delivery_shape_invalid",
        );
        return;
      }
      this.publishObservedDelivery(deliveryResult.delivery, text.byteLength);
      return;
    }

    if (schemaVersion === OBSERVED_RUNTIME_EVIDENCE_ENVELOPE_SCHEMA) {
      this.fail("runtime_evidence_transport_router_observed_delivery_required");
      return;
    }

    if (typeof schemaVersion !== "string") {
      this.fail("runtime_evidence_transport_router_message_schema_invalid");
      return;
    }
    this.fail("runtime_evidence_transport_router_message_schema_unknown");
  }

  private publishObservedDelivery(
    delivery: RuntimeEvidenceTransportObservedDelivery,
    byteLength: number,
  ): void {
    if (
      this.retainedObservedDeliveries.length
      >= this.retainedObservedDeliveryCapacity
    ) {
      this.fail("runtime_evidence_transport_router_retention_capacity_exhausted");
      return;
    }
    if (
      byteLength
      > this.maxRetainedObservedDeliveryBytes - this.retainedObservedDeliveryBytes
    ) {
      this.fail("runtime_evidence_transport_router_retained_byte_capacity_exhausted");
      return;
    }
    this.retainedObservedDeliveries.push(delivery);
    this.retainedObservedDeliveryBytes += byteLength;
    for (const listener of [...this.listeners]) {
      if (this.disposed || this.failureReason !== null) return;
      try {
        listener(delivery);
      } catch {
        // Support subscribers cannot interrupt transport isolation or promote evidence.
      }
    }
  }

  private fail(reason: string): void {
    if (this.disposed || this.failureReason !== null) return;
    this.failureReason = reason;
    this.unbind?.();
    this.unbind = null;
    this.unsubscribeKeyPin?.();
    this.unsubscribeKeyPin = null;
    this.boundChannel = null;
    this.listeners.clear();
    this.retainedObservedDeliveries.length = 0;
    this.retainedObservedDeliveryBytes = 0;
    this.notifyStatusChange();
    this.statusListeners.clear();
  }

  private notifyStatusListener(
    listener: RuntimeEvidenceTransportChannelRouterListener,
    snapshot: RuntimeEvidenceTransportChannelRouterSnapshot,
  ): void {
    try {
      listener(snapshot);
    } catch {
      // A diagnostic observer cannot interrupt transport isolation.
    }
  }

  private notifyStatusChange(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.statusListeners]) {
      this.notifyStatusListener(listener, snapshot);
    }
  }

  private normalizeLimits(
    limits: RuntimeEvidenceTransportChannelRouterLimits,
  ): Readonly<{
    maxRetainedObservedDeliveryCount: number;
    maxMessageBytes: number;
    maxRetainedObservedDeliveryBytes: number;
  }> {
    try {
      if (
        limits === null
        || typeof limits !== "object"
        || isProxy(limits)
        || Array.isArray(limits)
        || Object.getPrototypeOf(limits) !== Object.prototype
      ) {
        throw new Error("invalid limits shape");
      }
      const ownKeys = Reflect.ownKeys(limits);
      const allowedKeys = new Set<string>(ROUTER_LIMIT_KEYS);
      if (ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
        throw new Error("invalid limits keys");
      }
      const rawValues: Record<string, unknown> = {};
      for (const key of ROUTER_LIMIT_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(limits, key);
        if (descriptor === undefined) continue;
        if (
          descriptor.enumerable !== true
          || !Object.prototype.hasOwnProperty.call(descriptor, "value")
          || Object.prototype.hasOwnProperty.call(descriptor, "get")
          || Object.prototype.hasOwnProperty.call(descriptor, "set")
        ) {
          throw new Error("invalid limits descriptor");
        }
        rawValues[key] = descriptor.value;
      }
      const values: {
        maxRetainedObservedDeliveryCount: number;
        maxMessageBytes: number;
        maxRetainedObservedDeliveryBytes: number;
      } = {
        maxRetainedObservedDeliveryCount:
          rawValues.maxRetainedObservedDeliveryCount === undefined
            ? DEFAULT_ROUTER_RETAINED_OBSERVED_DELIVERY_CAPACITY
            : rawValues.maxRetainedObservedDeliveryCount as number,
        maxMessageBytes: rawValues.maxMessageBytes === undefined
          ? RUNTIME_EVIDENCE_TRANSPORT_MAX_MESSAGE_BYTES
          : rawValues.maxMessageBytes as number,
        maxRetainedObservedDeliveryBytes:
          rawValues.maxRetainedObservedDeliveryBytes === undefined
            ? DEFAULT_ROUTER_MAX_RETAINED_OBSERVED_DELIVERY_BYTES
            : rawValues.maxRetainedObservedDeliveryBytes as number,
      };
      if (Object.values(values).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
        throw new Error("invalid limits value");
      }
      if (values.maxMessageBytes > RUNTIME_EVIDENCE_TRANSPORT_MAX_MESSAGE_BYTES) {
        throw new Error("message limit exceeds protocol maximum");
      }
      return Object.freeze(values);
    } catch {
      throw new Error("runtime_evidence_transport_router_limits_invalid");
    }
  }

  private disposeOwnedKeyPin(): void {
    if (!this.ownsKeyPin) return;
    this.ownsKeyPin = false;
    this.disposingOwnedKeyPin = true;
    try {
      this.keyPin.dispose();
    } finally {
      this.disposingOwnedKeyPin = false;
    }
  }
}

export class RuntimeEvidenceTransportReceiptConsumer {
  private disposed = false;
  private compatibilityConsumeInFlight = false;
  private preparationInFlight = false;
  readonly #preparedStates = new Map<
    RuntimeEvidenceTransportPreparedSupportEnvelope,
    RuntimeEvidenceTransportPreparedState
  >();
  readonly #retiredCapabilities = new WeakSet<
    RuntimeEvidenceTransportPreparedSupportEnvelope
  >();

  constructor(
    private readonly keyPin: RuntimeEvidenceTransportKeyPin,
    private readonly replayStore: RuntimeEvidenceTransportReplayStore,
    private readonly clockUnixNs: () => bigint = () => BigInt(Date.now()) * 1_000_000n,
  ) {}

  consumeSupportEnvelope(
    input: RuntimeEvidenceTransportSupportEnvelopeInput,
  ): RuntimeEvidenceTransportSupportVerification {
    if (this.compatibilityConsumeInFlight) {
      return supportVerification(
        false,
        "runtime_evidence_transport_compatibility_consume_reentry_suppressed",
      );
    }
    this.compatibilityConsumeInFlight = true;
    try {
      const preparation = this.prepareSupportEnvelopeGuarded(input, true);
      if (preparation.capability === null) {
        return supportVerification(
          false,
          preparation.reason ?? "runtime_evidence_transport_preparation_failed",
        );
      }
      return this.commitPreparedSupportEnvelopeInternal(
        preparation.capability,
        false,
      );
    } finally {
      this.compatibilityConsumeInFlight = false;
    }
  }

  prepareSupportEnvelope(
    input: RuntimeEvidenceTransportSupportEnvelopeInput,
  ): RuntimeEvidenceTransportSupportPreparation {
    return this.prepareSupportEnvelopeGuarded(input, false);
  }

  private prepareSupportEnvelopeGuarded(
    input: RuntimeEvidenceTransportSupportEnvelopeInput,
    reservedCompatibilitySlot: boolean,
  ): RuntimeEvidenceTransportSupportPreparation {
    if (this.preparationInFlight) {
      return supportPreparation(
        false,
        "runtime_evidence_transport_preparation_reentry_suppressed",
        null,
      );
    }
    this.preparationInFlight = true;
    try {
      return this.prepareSupportEnvelopeInternal(
        input,
        reservedCompatibilitySlot,
      );
    } finally {
      this.preparationInFlight = false;
    }
  }

  private prepareSupportEnvelopeInternal(
    input: RuntimeEvidenceTransportSupportEnvelopeInput,
    reservedCompatibilitySlot: boolean,
  ): RuntimeEvidenceTransportSupportPreparation {
    if (this.disposed) {
      return supportPreparation(
        false,
        "runtime_evidence_transport_consumer_disposed",
        null,
      );
    }
    let pin: RuntimeEvidenceTransportKeyPinSnapshot;
    try {
      pin = this.keyPin.snapshot();
    } catch {
      return supportPreparation(
        false,
        "runtime_evidence_transport_verification_key_not_pinned",
        null,
      );
    }
    if (pin.status !== "pinned" || pin.key === null) {
      return supportPreparation(
        false,
        pin.failureReason ?? "runtime_evidence_transport_verification_key_not_pinned",
        null,
      );
    }
    const keyIdentity = verificationKeyIdentity(pin.key);
    if (keyIdentity === null) {
      return supportPreparation(
        false,
        "runtime_evidence_transport_verification_key_invalid",
        null,
      );
    }
    const inputSnapshot = snapshotSupportEnvelopeInput(input);
    if (inputSnapshot === null) {
      return supportPreparation(
        false,
        "runtime_evidence_transport_verification_context_invalid",
        null,
      );
    }
    let core: RuntimeEvidenceTransportSharedCoreResult;
    try {
      core = verifyRuntimeEvidenceTransportSupportEnvelopeCryptographicCore(
        pin.key,
        inputSnapshot.envelope,
        inputSnapshot.observedPayload,
        inputSnapshot.context,
      );
    } catch {
      return supportPreparation(
        false,
        "runtime_evidence_transport_verification_failed",
        null,
      );
    }
    if (core.onlinePolicy === null) {
      return supportPreparation(
        false,
        core.verification.reason ?? "runtime_evidence_transport_verification_failed",
        null,
      );
    }
    const policy = core.onlinePolicy;
    const nowUnixNs = this.currentUnixNs();
    if (nowUnixNs === null) {
      return supportPreparation(
        false,
        "runtime_evidence_transport_clock_failed",
        null,
      );
    }
    const freshnessFailure = this.freshnessFailure(policy, nowUnixNs);
    if (freshnessFailure !== null) {
      return supportPreparation(false, freshnessFailure, null);
    }
    const postClockTrustFailure = this.trustFailure(keyIdentity);
    if (postClockTrustFailure !== null) {
      return supportPreparation(false, postClockTrustFailure, null);
    }
    this.prunePreparedStates(nowUnixNs);
    const capacity = reservedCompatibilitySlot
      ? MAX_PENDING_PREPARED_SUPPORT_ENVELOPES
      : MAX_RETAINED_CALLER_PREPARED_SUPPORT_ENVELOPES;
    if (this.#preparedStates.size >= capacity) {
      return supportPreparation(
        false,
        "runtime_evidence_transport_prepared_capability_capacity_exhausted",
        null,
      );
    }

    const capability = preparedSupportEnvelopeCapability();
    this.#preparedStates.set(capability, Object.freeze({
      verification: core.verification,
      onlinePolicy: policy,
      keyIdentity,
      expiresAtUnixNs: nowUnixNs + PREPARED_SUPPORT_ENVELOPE_TTL_NS,
    }));
    return supportPreparation(
      true,
      null,
      capability,
      core.verification.receiptId,
      core.verification.observationContextHash,
      true,
    );
  }

  commitPreparedSupportEnvelope(
    capability: RuntimeEvidenceTransportPreparedSupportEnvelope,
  ): RuntimeEvidenceTransportSupportVerification {
    return this.commitPreparedSupportEnvelopeInternal(capability, true);
  }

  discardPreparedSupportEnvelope(
    capability: RuntimeEvidenceTransportPreparedSupportEnvelope,
  ): boolean {
    if (capability === null || typeof capability !== "object") return false;
    if (this.#retiredCapabilities.has(capability)) return false;
    if (!this.#preparedStates.delete(capability)) return false;
    this.#retiredCapabilities.add(capability);
    return true;
  }

  private commitPreparedSupportEnvelopeInternal(
    capability: RuntimeEvidenceTransportPreparedSupportEnvelope,
    recheckFreshness: boolean,
  ): RuntimeEvidenceTransportSupportVerification {
    if (capability === null || typeof capability !== "object") {
      return supportVerification(
        false,
        "runtime_evidence_transport_prepared_capability_invalid",
      );
    }
    if (this.#retiredCapabilities.has(capability)) {
      return supportVerification(
        false,
        "runtime_evidence_transport_prepared_capability_already_used",
      );
    }
    const prepared = this.#preparedStates.get(capability);
    if (prepared === undefined) {
      return supportVerification(
        false,
        "runtime_evidence_transport_prepared_capability_invalid",
      );
    }
    this.#preparedStates.delete(capability);
    this.#retiredCapabilities.add(capability);

    const initialTrustFailure = this.trustFailure(prepared.keyIdentity);
    if (initialTrustFailure !== null) {
      return supportVerification(false, initialTrustFailure);
    }

    const policy = prepared.onlinePolicy;
    if (recheckFreshness) {
      const nowUnixNs = this.currentUnixNs();
      if (nowUnixNs === null) {
        return supportVerification(false, "runtime_evidence_transport_clock_failed");
      }
      if (nowUnixNs > prepared.expiresAtUnixNs) {
        return supportVerification(
          false,
          "runtime_evidence_transport_prepared_capability_expired",
        );
      }
      const freshnessFailure = this.freshnessFailure(policy, nowUnixNs);
      if (freshnessFailure !== null) {
        return supportVerification(false, freshnessFailure);
      }
      const postClockTrustFailure = this.trustFailure(prepared.keyIdentity);
      if (postClockTrustFailure !== null) {
        return supportVerification(false, postClockTrustFailure);
      }
    }

    let replayFailure: string | null;
    try {
      replayFailure = this.replayStore.consumeIfNewer(
        policy.keyId,
        policy.workerInstanceId,
        policy.transportSessionBindingSha256,
        policy.sequence,
        policy.receiptId,
      );
    } catch {
      return supportVerification(false, "runtime_evidence_transport_replay_store_failed");
    }
    if (replayFailure !== null) return supportVerification(false, replayFailure);
    const postReplayTrustFailure = this.trustFailure(prepared.keyIdentity);
    if (postReplayTrustFailure !== null) {
      return supportVerification(false, postReplayTrustFailure);
    }
    return prepared.verification;
  }

  private currentUnixNs(): bigint | null {
    let nowUnixNs: bigint;
    try {
      nowUnixNs = this.clockUnixNs();
    } catch {
      return null;
    }
    return typeof nowUnixNs === "bigint" ? nowUnixNs : null;
  }

  private freshnessFailure(
    policy: RuntimeEvidenceTransportOnlinePolicy,
    nowUnixNs: bigint,
  ): string | null {
    if (nowUnixNs < 0n) return "runtime_evidence_transport_clock_before_epoch";
    if (policy.issuedAtUnixNs > nowUnixNs + MAX_FUTURE_SKEW_NS) {
      return "runtime_evidence_transport_receipt_from_future";
    }
    if (
      policy.issuedAtUnixNs <= nowUnixNs
      && nowUnixNs - policy.issuedAtUnixNs > MAX_RECEIPT_AGE_NS
    ) {
      return "runtime_evidence_transport_receipt_expired";
    }
    return null;
  }

  private trustFailure(
    expectedKeyIdentity: RuntimeEvidenceTransportVerificationKeyIdentity,
  ): string | null {
    if (this.disposed) return "runtime_evidence_transport_consumer_disposed";
    let pin: RuntimeEvidenceTransportKeyPinSnapshot;
    try {
      pin = this.keyPin.snapshot();
    } catch {
      return "runtime_evidence_transport_verification_key_not_pinned";
    }
    if (pin.status !== "pinned" || pin.key === null) {
      return pin.failureReason
        ?? "runtime_evidence_transport_verification_key_not_pinned";
    }
    const currentKeyIdentity = verificationKeyIdentity(pin.key);
    if (currentKeyIdentity === null) {
      return "runtime_evidence_transport_verification_key_invalid";
    }
    return sameVerificationKeyIdentity(expectedKeyIdentity, currentKeyIdentity)
      ? null
      : "runtime_evidence_transport_verification_key_changed_after_prepare";
  }

  private prunePreparedStates(nowUnixNs: bigint): void {
    for (const [capability, prepared] of this.#preparedStates) {
      if (prepared.expiresAtUnixNs >= nowUnixNs) continue;
      this.#preparedStates.delete(capability);
      this.#retiredCapabilities.add(capability);
    }
  }

  dispose(): void {
    this.#preparedStates.clear();
    this.disposed = true;
  }
}
