import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { isProxy, isUint8Array } from "node:util/types";

export const RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA =
  "synthi.gpu_hmr.runtime_evidence_transport_verification_key.v1";
export const RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM = "ed25519";
export const RUNTIME_EVIDENCE_TRANSPORT_PRODUCER = "synthi-webrtc-compiler-worker";

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
const U64_MAX = 18_446_744_073_709_551_615n;
const U128_MAX = 340_282_366_920_938_463_463_374_607_431_768_211_455n;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const VERIFICATION_KEY_KEYS = [
  "algorithm",
  "keyAnnouncementId",
  "keyId",
  "producer",
  "publicKey",
  "schemaVersion",
  "workerInstanceId",
  "workerProcessId",
];

const VERIFICATION_CONTEXT_KEYS = [
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
];

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
];

const ENVELOPE_KEYS = [
  "schemaVersion",
  "type",
  "observedPayloadSha256",
  "runtimeEvidenceTransportReceipt",
  "proofAuthority",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
];

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function prefixedSha256(value) {
  return `sha256:${sha256Hex(value)}`;
}

function snapshotExactDataObject(value, requiredKeys) {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== requiredKeys.length) return null;
    const requiredKeySet = new Set(requiredKeys);
    if (ownKeys.some((key) => typeof key !== "string" || !requiredKeySet.has(key))) {
      return null;
    }

    const snapshot = {};
    for (const key of requiredKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")
        || Object.prototype.hasOwnProperty.call(descriptor, "get")
        || Object.prototype.hasOwnProperty.call(descriptor, "set")
      ) {
        return null;
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function canonicalPrefixedSha256(value, prefix) {
  return typeof value === "string"
    && new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-f0-9]{64}$`).test(value);
}

function canonicalSha256(value) {
  return canonicalPrefixedSha256(value, "sha256:");
}

function canonicalWorkerProcessId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 0xffff_ffff;
}

function canonicalToken(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[\x21-\x7e]+$/.test(value);
}

function canonicalDecimal(value, max) {
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

function canonicalRuntimeProofId(value) {
  return canonicalPrefixedSha256(value, "gpu-runtime-proof:sha256:");
}

function canonicalLedgerProofId(value) {
  return canonicalPrefixedSha256(value, "gpu-ledger-proof:sha256:");
}

function canonicalRequestId(value) {
  return typeof value === "string" && /^gpu-reload:request:[a-f0-9]{32}$/.test(value);
}

function canonicalSourceEditId(value) {
  return canonicalPrefixedSha256(value, "source-edit:sha256:");
}

function decodeCanonicalBase64Url(value, byteLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== byteLength || decoded.toString("base64url") !== value) return null;
  return decoded;
}

function decodeCanonicalPublicKey(value) {
  return decodeCanonicalBase64Url(value, 32);
}

function supportVerification(
  verified,
  reason,
  receiptId = null,
  observationContextHash = null,
) {
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

function coreResult(verification, onlinePolicy = null) {
  return Object.freeze({ verification, onlinePolicy });
}

export function parseRuntimeEvidenceTransportVerificationKey(value) {
  const raw = snapshotExactDataObject(value, VERIFICATION_KEY_KEYS);
  if (raw === null) return null;
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
    publicKey: raw.publicKey,
    keyAnnouncementId: raw.keyAnnouncementId,
  });
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;

function snapshotBytes(value) {
  try {
    if (typeof value === "string") return Buffer.from(value, "utf8");
    if (
      value === null
      || typeof value !== "object"
      || isProxy(value)
      || !ArrayBuffer.isView(value)
      || !isUint8Array(value)
      || TYPED_ARRAY_BUFFER_GETTER === undefined
      || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
      || TYPED_ARRAY_BYTE_OFFSET_GETTER === undefined
    ) {
      return null;
    }
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []);
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
    const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []);
    return Buffer.from(new Uint8Array(buffer, byteOffset, byteLength));
  } catch {
    return null;
  }
}

function snapshotVerificationInputs(contextValue, observedPayloadValue) {
  const context = snapshotExactDataObject(contextValue, VERIFICATION_CONTEXT_KEYS);
  if (context === null) return null;
  const subjectCanonicalBytes = snapshotBytes(context.subjectCanonicalBytes);
  const observedPayload = snapshotBytes(observedPayloadValue);
  if (
    !Number.isSafeInteger(context.runnerProcessId)
    || context.runnerProcessId < 1
    || context.runnerProcessId > 0xffff_ffff
    || !canonicalToken(context.runtimeSessionId)
    || typeof context.runnerChallenge !== "string"
    || !/^[a-f0-9]{32}$/.test(context.runnerChallenge)
    || !canonicalToken(context.transportSessionId)
    || !canonicalRequestId(context.requestId)
    || !canonicalSourceEditId(context.sourceEditId)
    || !canonicalToken(context.subjectIdentityNamespace)
    || subjectCanonicalBytes === null
    || subjectCanonicalBytes.byteLength === 0
    || !canonicalSha256(context.artifactContentHash)
    || !canonicalRuntimeProofId(context.observedRuntimeProofId)
    || !canonicalLedgerProofId(context.observedProofLedgerId)
    || observedPayload === null
    || observedPayload.byteLength === 0
  ) {
    return null;
  }
  return Object.freeze({
    context,
    subjectCanonicalBytesSha256: prefixedSha256(subjectCanonicalBytes),
    observedPayloadSha256: prefixedSha256(observedPayload),
  });
}

function validateReceiptShape(receipt) {
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

/**
 * Pure strict verification core. It intentionally performs no wall-clock or replay-store checks.
 * The immutable onlinePolicy fields are derived only after all shape, identity, hash, ID, and
 * signature checks pass.
 */
export function verifyRuntimeEvidenceTransportSupportEnvelopeCryptographicCore(
  verificationKey,
  envelopeValue,
  observedPayload,
  contextValue,
) {
  const verificationKeyResult = parseRuntimeEvidenceTransportVerificationKey(verificationKey);
  if (verificationKeyResult === null) {
    return coreResult(supportVerification(
      false,
      "runtime_evidence_transport_verification_key_invalid",
    ));
  }

  const inputs = snapshotVerificationInputs(contextValue, observedPayload);
  if (inputs === null) {
    return coreResult(supportVerification(
      false,
      "runtime_evidence_transport_verification_context_invalid",
    ));
  }
  const context = inputs.context;

  const envelope = snapshotExactDataObject(envelopeValue, ENVELOPE_KEYS);
  if (envelope === null) {
    return coreResult(supportVerification(
      false,
      "observed_runtime_evidence_envelope_shape_invalid",
    ));
  }
  if (
    envelope.schemaVersion !== OBSERVED_ENVELOPE_SCHEMA
    || envelope.type !== OBSERVED_ENVELOPE_TYPE
    || envelope.proofAuthority !== OBSERVED_ENVELOPE_AUTHORITY
    || envelope.acceptedForGpuHmr !== false
    || envelope.gpuHmrSuccess !== false
    || envelope.canSatisfyRuntimeProof !== false
  ) {
    return coreResult(supportVerification(
      false,
      "observed_runtime_evidence_envelope_shape_invalid",
    ));
  }

  const receipt = snapshotExactDataObject(
    envelope.runtimeEvidenceTransportReceipt,
    RECEIPT_KEYS,
  );
  if (receipt === null) {
    return coreResult(supportVerification(
      false,
      "runtime_evidence_transport_receipt_field_shape_invalid",
    ));
  }
  const shapeFailure = validateReceiptShape(receipt);
  if (shapeFailure !== null) return coreResult(supportVerification(false, shapeFailure));

  const observedPayloadSha256 = inputs.observedPayloadSha256;
  if (
    envelope.observedPayloadSha256 !== observedPayloadSha256
    || receipt.observedPayloadSha256 !== observedPayloadSha256
  ) {
    return coreResult(supportVerification(
      false,
      "runtime_evidence_transport_observed_payload_hash_mismatch",
    ));
  }

  const subjectIdentityHash = prefixedSha256(JSON.stringify([
    SUBJECT_IDENTITY_DOMAIN,
    context.subjectIdentityNamespace,
    inputs.subjectCanonicalBytesSha256,
  ]));
  const transportSessionBindingSha256 = prefixedSha256(
    `required\0${context.transportSessionId}`,
  );
  const runnerChallengeSha256 = prefixedSha256(context.runnerChallenge);
  const runnerProcessId = String(context.runnerProcessId);
  if (
    receipt.keyId !== verificationKeyResult.keyId
    || receipt.workerInstanceId !== verificationKeyResult.workerInstanceId
    || receipt.workerProcessId !== verificationKeyResult.workerProcessId
    || receipt.runnerProcessId !== runnerProcessId
    || receipt.runtimeSessionId !== context.runtimeSessionId
    || receipt.runnerChallengeSha256 !== runnerChallengeSha256
    || receipt.transportSessionBindingSha256 !== transportSessionBindingSha256
    || receipt.requestId !== context.requestId
    || receipt.sourceEditId !== context.sourceEditId
    || receipt.subjectIdentityNamespace !== context.subjectIdentityNamespace
    || receipt.subjectIdentityHash !== subjectIdentityHash
    || receipt.artifactContentHash !== context.artifactContentHash
    || receipt.observedRuntimeProofId !== context.observedRuntimeProofId
    || receipt.observedProofLedgerId !== context.observedProofLedgerId
  ) {
    return coreResult(supportVerification(
      false,
      "runtime_evidence_transport_verification_context_mismatch",
    ));
  }

  const observationContextHash = prefixedSha256(JSON.stringify([
    OBSERVATION_CONTEXT_DOMAIN,
    verificationKeyResult.keyId,
    verificationKeyResult.workerInstanceId,
    verificationKeyResult.workerProcessId,
    runnerProcessId,
    context.runtimeSessionId,
    runnerChallengeSha256,
    transportSessionBindingSha256,
    context.requestId,
    context.sourceEditId,
    context.subjectIdentityNamespace,
    subjectIdentityHash,
    context.artifactContentHash,
    context.observedRuntimeProofId,
    context.observedProofLedgerId,
    observedPayloadSha256,
  ]));
  if (receipt.observationContextHash !== observationContextHash) {
    return coreResult(supportVerification(
      false,
      "runtime_evidence_transport_verification_context_hash_mismatch",
    ));
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
    return coreResult(supportVerification(
      false,
      "runtime_evidence_transport_receipt_id_mismatch",
    ));
  }

  const signature = decodeCanonicalBase64Url(
    receipt.signature.slice(SIGNATURE_PREFIX.length),
    64,
  );
  const publicKeyBytes = decodeCanonicalPublicKey(verificationKeyResult.publicKey);
  if (signature === null || publicKeyBytes === null) {
    return coreResult(supportVerification(
      false,
      "runtime_evidence_transport_signature_shape_invalid",
    ));
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    if (!verifySignature(null, signingBytes, publicKey, signature)) {
      return coreResult(supportVerification(
        false,
        "runtime_evidence_transport_signature_mismatch",
      ));
    }
  } catch {
    return coreResult(supportVerification(
      false,
      "runtime_evidence_transport_signature_mismatch",
    ));
  }

  const verification = supportVerification(
    true,
    null,
    receipt.receiptId,
    observationContextHash,
  );
  const onlinePolicy = Object.freeze({
    issuedAtUnixNs: BigInt(receipt.issuedAtUnixNs),
    sequence: BigInt(receipt.sequence),
    keyId: receipt.keyId,
    workerInstanceId: receipt.workerInstanceId,
    transportSessionBindingSha256: receipt.transportSessionBindingSha256,
    receiptId: receipt.receiptId,
  });
  return coreResult(verification, onlinePolicy);
}

/**
 * Verifies support-only evidence without consulting a clock or mutable replay state.
 */
export function verifyRuntimeEvidenceTransportSupportEnvelopeOffline(
  verificationKey,
  envelope,
  observedPayload,
  context,
) {
  return verifyRuntimeEvidenceTransportSupportEnvelopeCryptographicCore(
    verificationKey,
    envelope,
    observedPayload,
    context,
  ).verification;
}
