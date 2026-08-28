import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { isProxy } from "node:util/types";
import {
  GPU_HMR_MCP_ADMISSION_ALGORITHM,
  GPU_HMR_MCP_ADMISSION_PRODUCER,
  hashGpuHmrMcpValidationRunChallenge,
  parseGpuHmrMcpAdmissionVerificationKey,
} from "./gpu-hmr-mcp-admission-receipt-verifier.mjs";

export const GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA =
  "synthi.gpu_hmr.mcp_output_observation_receipt.v1";
export const GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY =
  "mcp_signed_output_byte_observation_support_only_not_gpu_hmr_acceptance";
export const GPU_HMR_MCP_OUTPUT_OBSERVATION_VERIFICATION_AUTHORITY =
  "mcp_output_observation_signature_and_challenge_support_only_runtime_binding_bytes_replay_and_freshness_unchecked_not_gpu_hmr_acceptance";

const VERIFICATION_SCHEMA =
  "synthi.gpu_hmr.mcp_output_observation_receipt_verification.v1";
const SIGNING_DOMAIN =
  "synthi.gpu_hmr.mcp_output_observation_receipt_signing.v1";
const RECEIPT_ID_DOMAIN =
  "synthi.gpu_hmr.mcp_output_observation_receipt_id.v1";
const REPLAY_SCOPE_DOMAIN =
  "synthi.gpu_hmr.mcp_output_observation_receipt_replay_scope.v1";
const RECEIPT_ID_PREFIX =
  "gpu-hmr-mcp-output-observation-receipt:sha256:";
const REPLAY_SCOPE_ID_PREFIX =
  "gpu-hmr-mcp-output-observation-replay-scope:sha256:";
const SIGNATURE_PREFIX = "ed25519:";
const U64_MAX = 18_446_744_073_709_551_615n;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

const INPUT_KEYS = [
  "transportSessionId",
  "requestChallengeSha256",
  "runtimeBindingSha256",
  "producerObservationSha256",
  "outputContentSha256",
  "outputByteLength",
  "observedAtMonotonicNs",
];

const SIGNED_KEYS = [
  "schemaVersion",
  "algorithm",
  "signerKeyId",
  "producer",
  "proofAuthority",
  "outputBytesObserved",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
  "validationRunChallengeSha256",
  ...INPUT_KEYS,
  "issuedAtUnixNs",
  "sequence",
  "nonce",
];

const RECEIPT_KEYS = [
  ...SIGNED_KEYS,
  "receiptId",
  "signature",
];

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function snapshotExactDataObject(value, requiredKeys) {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    const requiredKeySet = new Set(requiredKeys);
    if (
      ownKeys.length !== requiredKeys.length
      || ownKeys.some((key) => typeof key !== "string" || !requiredKeySet.has(key))
    ) {
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

function canonicalSha256(value) {
  return typeof value === "string"
    && /^sha256:[a-f0-9]{64}$/.test(value);
}

function canonicalToken(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[\x21-\x7e]+$/.test(value);
}

function canonicalDecimalU64(value, allowZero) {
  if (
    typeof value !== "string"
    || value.length > U64_MAX.toString().length
    || !(allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)
  ) {
    return false;
  }
  try {
    return BigInt(value) <= U64_MAX;
  } catch {
    return false;
  }
}

function decodeCanonicalBase64Url(value, byteLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === byteLength
      && decoded.toString("base64url") === value
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function validInputFields(value) {
  return canonicalToken(value.transportSessionId)
    && canonicalSha256(value.requestChallengeSha256)
    && canonicalSha256(value.runtimeBindingSha256)
    && canonicalSha256(value.producerObservationSha256)
    && canonicalSha256(value.outputContentSha256)
    && canonicalDecimalU64(value.outputByteLength, true)
    && canonicalDecimalU64(value.observedAtMonotonicNs, true);
}

function validSignedFields(value) {
  return value.schemaVersion === GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA
    && value.algorithm === GPU_HMR_MCP_ADMISSION_ALGORITHM
    && canonicalToken(value.signerKeyId)
    && value.producer === GPU_HMR_MCP_ADMISSION_PRODUCER
    && value.proofAuthority === GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY
    && value.outputBytesObserved === true
    && value.acceptedForGpuHmr === false
    && value.gpuHmrSuccess === false
    && value.canSatisfyRuntimeProof === false
    && canonicalSha256(value.validationRunChallengeSha256)
    && validInputFields(value)
    && canonicalDecimalU64(value.issuedAtUnixNs, true)
    && canonicalDecimalU64(value.sequence, false)
    && decodeCanonicalBase64Url(value.nonce, 32) !== null;
}

function signingBytesFromSnapshot(value) {
  return Buffer.from(JSON.stringify([
    SIGNING_DOMAIN,
    ...SIGNED_KEYS.map((key) => value[key]),
  ]), "utf8");
}

function receiptId(signingBytes, signatureBytes) {
  const digest = createHash("sha256")
    .update(RECEIPT_ID_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(signingBytes)
    .update("\0", "utf8")
    .update(signatureBytes)
    .digest("hex");
  return `${RECEIPT_ID_PREFIX}${digest}`;
}

function replayScope(value) {
  const replayScopeId = `${REPLAY_SCOPE_ID_PREFIX}${sha256Hex(JSON.stringify([
    REPLAY_SCOPE_DOMAIN,
    value.signerKeyId,
    value.validationRunChallengeSha256,
    value.transportSessionId,
  ]))}`;
  return Object.freeze({
    replayScopeId,
    signerKeyId: value.signerKeyId,
    validationRunChallengeSha256: value.validationRunChallengeSha256,
    transportSessionId: value.transportSessionId,
  });
}

function verificationResult(signatureVerified, reason, receipt = null) {
  return Object.freeze({
    schemaVersion: VERIFICATION_SCHEMA,
    signatureVerified,
    reason,
    verificationAuthority: GPU_HMR_MCP_OUTPUT_OBSERVATION_VERIFICATION_AUTHORITY,
    receiptId: receipt?.receiptId ?? null,
    issuedAtUnixNs: receipt === null ? null : BigInt(receipt.issuedAtUnixNs),
    observedAtMonotonicNs:
      receipt === null ? null : BigInt(receipt.observedAtMonotonicNs),
    sequence: receipt === null ? null : BigInt(receipt.sequence),
    replayScope: receipt === null ? null : replayScope(receipt),
    trustedKeyOriginChecked: false,
    requestChallengeChecked: false,
    runtimeBindingChecked: false,
    outputBytesChecked: false,
    replayChecked: false,
    freshnessChecked: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

export function parseGpuHmrMcpOutputObservationReceiptSigningInput(value) {
  const snapshot = snapshotExactDataObject(value, INPUT_KEYS);
  return snapshot !== null && validInputFields(snapshot) ? snapshot : null;
}

export function createGpuHmrMcpOutputObservationReceiptSigningBytes(value) {
  const snapshot = snapshotExactDataObject(value, SIGNED_KEYS);
  return snapshot !== null && validSignedFields(snapshot)
    ? signingBytesFromSnapshot(snapshot)
    : null;
}

export function finalizeGpuHmrMcpOutputObservationReceipt(
  value,
  signatureValue,
) {
  const snapshot = snapshotExactDataObject(value, SIGNED_KEYS);
  const signature = typeof signatureValue === "string"
    && signatureValue.startsWith(SIGNATURE_PREFIX)
    ? decodeCanonicalBase64Url(
      signatureValue.slice(SIGNATURE_PREFIX.length),
      64,
    )
    : null;
  if (snapshot === null || !validSignedFields(snapshot) || signature === null) {
    return null;
  }
  const signingBytes = signingBytesFromSnapshot(snapshot);
  return Object.freeze({
    ...snapshot,
    receiptId: receiptId(signingBytes, signature),
    signature: signatureValue,
  });
}

/**
 * Verifies a signature against the externally supplied key and validation-run
 * challenge. This primitive does not establish that either value came from a
 * live MCP session. A trusted consumer must pin that origin, then separately
 * bind the one-time request, runtime subject, observed bytes, freshness, and
 * replay state before this support receipt can be consumed.
 */
export function verifyGpuHmrMcpOutputObservationReceipt(
  trustedVerificationKeyValue,
  receiptValue,
  expectedValidationRunChallenge,
) {
  const trustedVerificationKey = parseGpuHmrMcpAdmissionVerificationKey(
    trustedVerificationKeyValue,
  );
  if (trustedVerificationKey === null) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_output_observation_verification_key_invalid",
    );
  }
  const expectedChallengeHash = hashGpuHmrMcpValidationRunChallenge(
    expectedValidationRunChallenge,
  );
  if (expectedChallengeHash === null) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_output_observation_expected_challenge_invalid",
    );
  }

  const receipt = snapshotExactDataObject(receiptValue, RECEIPT_KEYS);
  if (receipt === null || !validSignedFields(receipt)) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_output_observation_receipt_shape_invalid",
    );
  }
  const signatureValue = typeof receipt.signature === "string"
    && receipt.signature.startsWith(SIGNATURE_PREFIX)
    ? receipt.signature.slice(SIGNATURE_PREFIX.length)
    : null;
  const signature = signatureValue === null
    ? null
    : decodeCanonicalBase64Url(signatureValue, 64);
  if (
    signature === null
    || typeof receipt.receiptId !== "string"
    || !receipt.receiptId.startsWith(RECEIPT_ID_PREFIX)
    || !/^[a-f0-9]{64}$/.test(receipt.receiptId.slice(RECEIPT_ID_PREFIX.length))
  ) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_output_observation_receipt_shape_invalid",
    );
  }
  if (receipt.signerKeyId !== trustedVerificationKey.keyId) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_output_observation_signer_key_mismatch",
    );
  }
  if (receipt.validationRunChallengeSha256 !== expectedChallengeHash) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_output_observation_validation_run_challenge_mismatch",
    );
  }

  const signingBytes = signingBytesFromSnapshot(receipt);
  if (receipt.receiptId !== receiptId(signingBytes, signature)) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_output_observation_receipt_id_mismatch",
    );
  }
  try {
    const publicKeyBytes = Buffer.from(trustedVerificationKey.publicKey, "base64url");
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    if (!verifySignature(null, signingBytes, publicKey, signature)) {
      return verificationResult(
        false,
        "gpu_hmr_mcp_output_observation_signature_mismatch",
      );
    }
  } catch {
    return verificationResult(
      false,
      "gpu_hmr_mcp_output_observation_signature_mismatch",
    );
  }
  return verificationResult(true, null, receipt);
}
