import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { isProxy } from "node:util/types";

export const GPU_HMR_MCP_ADMISSION_VERIFICATION_KEY_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_verification_key.v1";
export const GPU_HMR_MCP_ADMISSION_RECEIPT_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_receipt.v1";
export const GPU_HMR_MCP_ADMISSION_ALGORITHM = "ed25519";
export const GPU_HMR_MCP_ADMISSION_PRODUCER = "synthi-mcp";
export const GPU_HMR_MCP_ADMISSION_RECEIPT_AUTHORITY =
  "mcp_signed_control_and_parent_proof_admission_support_only_not_gpu_hmr_acceptance";
export const GPU_HMR_MCP_ADMISSION_VERIFICATION_AUTHORITY =
  "mcp_admission_signature_and_challenge_binding_support_only_replay_and_freshness_unchecked_not_gpu_hmr_acceptance";

const VERIFICATION_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_receipt_verification.v1";
const SIGNING_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_receipt_signing.v1";
const RECEIPT_ID_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_receipt_id.v1";
const REPLAY_SCOPE_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_receipt_replay_scope.v1";
const KEY_ID_PREFIX = "gpu-hmr-mcp-admission-key:sha256:";
const RECEIPT_ID_PREFIX = "gpu-hmr-mcp-admission-receipt:sha256:";
const REPLAY_SCOPE_ID_PREFIX =
  "gpu-hmr-mcp-admission-replay-scope:sha256:";
const WORKER_KEY_ID_PREFIX =
  "gpu-hmr-runtime-evidence-transport-key:sha256:";
const WORKER_KEY_ANNOUNCEMENT_ID_PREFIX =
  "gpu-hmr-runtime-evidence-transport-key-announcement:sha256:";
const CONTROL_BINDING_ID_PREFIX =
  "gpu-parent-runtime-proof-control-binding:sha256:";
const TRANSPORT_RECEIPT_ID_PREFIX =
  "gpu-hmr-runtime-evidence-transport-receipt:sha256:";
const PARENT_RECEIPT_ID_PREFIX =
  "gpu-parent-runtime-proof-receipt:sha256:";
const FULL_RUNTIME_PROOF_ID_PREFIX = "gpu-runtime-proof:sha256:";
const PROOF_LEDGER_ID_PREFIX = "gpu-ledger-proof:sha256:";
const SOURCE_EDIT_ID_PREFIX = "source-edit:sha256:";
const SIGNATURE_PREFIX = "ed25519:";
const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_PROCESS_ID = 0xffff_ffff;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

const VERIFICATION_KEY_KEYS = [
  "schemaVersion",
  "algorithm",
  "keyId",
  "producer",
  "publicKey",
];

const ADMISSION_INPUT_KEYS = [
  "transportSessionId",
  "compileRequestNonce",
  "computeExpectedOutputContractHash",
  "computeExpectedOutputSemanticsHash",
  "workerKeyId",
  "workerKeyAnnouncementId",
  "workerProcessId",
  "controlBindingId",
  "controlBindingCanonicalSha256",
  "controlTransportReceiptId",
  "controlObservationContextHash",
  "parentReceiptId",
  "parentTransportReceiptId",
  "parentCanonicalProofSha256",
  "parentObservationContextHash",
  "requestId",
  "sourceEditId",
  "artifactContentHash",
  "fullRuntimeProofId",
  "proofLedgerId",
  "runnerProcessId",
  "runnerRuntimeSessionId",
  "runnerChallenge",
  "commandEnvelopeSha256",
  "protectedProofJsonSha256",
];

const RECEIPT_SIGNED_KEYS = [
  "schemaVersion",
  "algorithm",
  "signerKeyId",
  "producer",
  "proofAuthority",
  "controlStageAdmitted",
  "parentProofStageAdmitted",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
  "validationRunChallengeSha256",
  ...ADMISSION_INPUT_KEYS,
  "admittedAtUnixNs",
  "sequence",
  "nonce",
];

const RECEIPT_KEYS = [
  ...RECEIPT_SIGNED_KEYS,
  "receiptId",
  "signature",
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
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== requiredKeys.length) return null;
    const requiredKeySet = new Set(requiredKeys);
    if (ownKeys.some(
      (key) => typeof key !== "string" || !requiredKeySet.has(key),
    )) {
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
    && value.length === prefix.length + 64
    && value.startsWith(prefix)
    && /^[a-f0-9]{64}$/.test(value.slice(prefix.length));
}

function canonicalSha256(value) {
  return canonicalPrefixedSha256(value, "sha256:");
}

function canonicalToken(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[\x21-\x7e]+$/.test(value);
}

function canonicalWorkerProcessId(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return false;
  try {
    return BigInt(value) <= BigInt(MAX_PROCESS_ID);
  } catch {
    return false;
  }
}

function canonicalRunnerProcessId(value) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_PROCESS_ID;
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
    if (
      decoded.byteLength !== byteLength
      || decoded.toString("base64url") !== value
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function canonicalOptionalSha256(value) {
  return value === null || canonicalSha256(value);
}

function validAdmissionFields(value) {
  return canonicalToken(value.transportSessionId)
    && typeof value.compileRequestNonce === "string"
    && /^gpu-proof-transport-request:[a-f0-9]{32}$/.test(
      value.compileRequestNonce,
    )
    && canonicalOptionalSha256(value.computeExpectedOutputContractHash)
    && canonicalOptionalSha256(value.computeExpectedOutputSemanticsHash)
    && canonicalPrefixedSha256(value.workerKeyId, WORKER_KEY_ID_PREFIX)
    && canonicalPrefixedSha256(
      value.workerKeyAnnouncementId,
      WORKER_KEY_ANNOUNCEMENT_ID_PREFIX,
    )
    && canonicalWorkerProcessId(value.workerProcessId)
    && canonicalPrefixedSha256(
      value.controlBindingId,
      CONTROL_BINDING_ID_PREFIX,
    )
    && canonicalSha256(value.controlBindingCanonicalSha256)
    && value.controlBindingId
      === `gpu-parent-runtime-proof-control-binding:${value.controlBindingCanonicalSha256}`
    && canonicalPrefixedSha256(
      value.controlTransportReceiptId,
      TRANSPORT_RECEIPT_ID_PREFIX,
    )
    && canonicalSha256(value.controlObservationContextHash)
    && canonicalPrefixedSha256(
      value.parentReceiptId,
      PARENT_RECEIPT_ID_PREFIX,
    )
    && canonicalPrefixedSha256(
      value.parentTransportReceiptId,
      TRANSPORT_RECEIPT_ID_PREFIX,
    )
    && canonicalSha256(value.parentCanonicalProofSha256)
    && canonicalSha256(value.parentObservationContextHash)
    && typeof value.requestId === "string"
    && /^gpu-reload:request:[a-f0-9]{32}$/.test(value.requestId)
    && canonicalPrefixedSha256(value.sourceEditId, SOURCE_EDIT_ID_PREFIX)
    && canonicalSha256(value.artifactContentHash)
    && canonicalPrefixedSha256(
      value.fullRuntimeProofId,
      FULL_RUNTIME_PROOF_ID_PREFIX,
    )
    && canonicalPrefixedSha256(value.proofLedgerId, PROOF_LEDGER_ID_PREFIX)
    && canonicalRunnerProcessId(value.runnerProcessId)
    && canonicalToken(value.runnerRuntimeSessionId)
    && typeof value.runnerChallenge === "string"
    && /^[a-f0-9]{32}$/.test(value.runnerChallenge)
    && canonicalSha256(value.commandEnvelopeSha256)
    && canonicalSha256(value.protectedProofJsonSha256);
}

function validSignedReceiptFields(value) {
  return value.schemaVersion === GPU_HMR_MCP_ADMISSION_RECEIPT_SCHEMA
    && value.algorithm === GPU_HMR_MCP_ADMISSION_ALGORITHM
    && canonicalPrefixedSha256(value.signerKeyId, KEY_ID_PREFIX)
    && value.producer === GPU_HMR_MCP_ADMISSION_PRODUCER
    && value.proofAuthority === GPU_HMR_MCP_ADMISSION_RECEIPT_AUTHORITY
    && value.controlStageAdmitted === true
    && value.parentProofStageAdmitted === true
    && value.acceptedForGpuHmr === false
    && value.gpuHmrSuccess === false
    && value.canSatisfyRuntimeProof === false
    && canonicalSha256(value.validationRunChallengeSha256)
    && validAdmissionFields(value)
    && canonicalDecimalU64(value.admittedAtUnixNs, true)
    && canonicalDecimalU64(value.sequence, false)
    && decodeCanonicalBase64Url(value.nonce, 32) !== null;
}

function signingBytesFromSnapshot(value) {
  return Buffer.from(JSON.stringify([
    SIGNING_DOMAIN,
    ...RECEIPT_SIGNED_KEYS.map((key) => value[key]),
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

function verificationResult(verified, reason, receipt = null) {
  return Object.freeze({
    schemaVersion: VERIFICATION_SCHEMA,
    verified,
    reason,
    verificationAuthority: GPU_HMR_MCP_ADMISSION_VERIFICATION_AUTHORITY,
    receiptId: receipt?.receiptId ?? null,
    admittedAtUnixNs:
      receipt === null ? null : BigInt(receipt.admittedAtUnixNs),
    sequence: receipt === null ? null : BigInt(receipt.sequence),
    replayScope: receipt === null ? null : replayScope(receipt),
    replayChecked: false,
    freshnessChecked: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

export function createGpuHmrMcpAdmissionVerificationKey(publicKeyValue) {
  const publicKey = decodeCanonicalBase64Url(publicKeyValue, 32);
  if (publicKey === null) return null;
  return Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_VERIFICATION_KEY_SCHEMA,
    algorithm: GPU_HMR_MCP_ADMISSION_ALGORITHM,
    keyId: `${KEY_ID_PREFIX}${sha256Hex(publicKey)}`,
    producer: GPU_HMR_MCP_ADMISSION_PRODUCER,
    publicKey: publicKeyValue,
  });
}

export function parseGpuHmrMcpAdmissionVerificationKey(value) {
  const snapshot = snapshotExactDataObject(value, VERIFICATION_KEY_KEYS);
  if (snapshot === null) return null;
  const expected = createGpuHmrMcpAdmissionVerificationKey(snapshot.publicKey);
  if (
    expected === null
    || snapshot.schemaVersion !== expected.schemaVersion
    || snapshot.algorithm !== expected.algorithm
    || snapshot.keyId !== expected.keyId
    || snapshot.producer !== expected.producer
  ) {
    return null;
  }
  return expected;
}

export function hashGpuHmrMcpValidationRunChallenge(value) {
  const challenge = decodeCanonicalBase64Url(value, 32);
  return challenge === null ? null : prefixedSha256(challenge);
}

export function parseGpuHmrMcpAdmissionReceiptSigningInput(value) {
  const snapshot = snapshotExactDataObject(value, ADMISSION_INPUT_KEYS);
  return snapshot !== null && validAdmissionFields(snapshot) ? snapshot : null;
}

export function createGpuHmrMcpAdmissionReceiptSigningBytes(value) {
  const snapshot = snapshotExactDataObject(value, RECEIPT_SIGNED_KEYS);
  return snapshot !== null && validSignedReceiptFields(snapshot)
    ? signingBytesFromSnapshot(snapshot)
    : null;
}

export function finalizeGpuHmrMcpAdmissionReceipt(value, signatureValue) {
  const snapshot = snapshotExactDataObject(value, RECEIPT_SIGNED_KEYS);
  const signature = typeof signatureValue === "string"
    && signatureValue.startsWith(SIGNATURE_PREFIX)
    ? decodeCanonicalBase64Url(
      signatureValue.slice(SIGNATURE_PREFIX.length),
      64,
    )
    : null;
  if (
    snapshot === null
    || !validSignedReceiptFields(snapshot)
    || signature === null
  ) {
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
 * Verifies only the MCP signature and the independently supplied validation-run
 * challenge. Replay and freshness are deliberately left to the caller.
 */
export function verifyGpuHmrMcpAdmissionReceipt(
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
      "gpu_hmr_mcp_admission_verification_key_invalid",
    );
  }

  const expectedChallengeHash = hashGpuHmrMcpValidationRunChallenge(
    expectedValidationRunChallenge,
  );
  if (expectedChallengeHash === null) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_admission_expected_challenge_invalid",
    );
  }

  const receipt = snapshotExactDataObject(receiptValue, RECEIPT_KEYS);
  if (receipt === null || !validSignedReceiptFields(receipt)) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_admission_receipt_shape_invalid",
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
    || !canonicalPrefixedSha256(receipt.receiptId, RECEIPT_ID_PREFIX)
  ) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_admission_receipt_shape_invalid",
    );
  }
  if (receipt.signerKeyId !== trustedVerificationKey.keyId) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_admission_signer_key_mismatch",
    );
  }
  if (receipt.validationRunChallengeSha256 !== expectedChallengeHash) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_admission_validation_run_challenge_mismatch",
    );
  }

  const signingBytes = signingBytesFromSnapshot(receipt);
  if (receipt.receiptId !== receiptId(signingBytes, signature)) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_admission_receipt_id_mismatch",
    );
  }

  const publicKeyBytes = decodeCanonicalBase64Url(
    trustedVerificationKey.publicKey,
    32,
  );
  if (publicKeyBytes === null) {
    return verificationResult(
      false,
      "gpu_hmr_mcp_admission_verification_key_invalid",
    );
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    if (!verifySignature(null, signingBytes, publicKey, signature)) {
      return verificationResult(
        false,
        "gpu_hmr_mcp_admission_signature_mismatch",
      );
    }
  } catch {
    return verificationResult(
      false,
      "gpu_hmr_mcp_admission_signature_mismatch",
    );
  }

  return verificationResult(true, null, receipt);
}
