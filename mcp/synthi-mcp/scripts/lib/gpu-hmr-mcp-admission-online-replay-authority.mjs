import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  verify as verifySignature,
} from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isProxy } from "node:util/types";
import {
  hashGpuHmrMcpValidationRunChallenge,
  parseGpuHmrMcpAdmissionVerificationKey,
  verifyGpuHmrMcpAdmissionReceipt,
} from "./gpu-hmr-mcp-admission-receipt-verifier.mjs";

export const GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_SERVER_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_online_replay_authority_server.v1";
export const GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLIENT_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_online_replay_authority_client.v1";
export const GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_REQUEST_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_online_replay_cas_request.v1";
export const GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_RESULT_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_replay_cas_result.v1";
export const GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_RESPONSE_KEY_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_online_replay_response_key.v1";
export const GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_RESPONSE_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_online_replay_response.v1";
export const GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_REQUEST_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_online_replay_probe_request.v1";
export const GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_online_replay_probe_response.v1";
export const GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS =
  "online_parent_process";

const SERVER_PROOF_AUTHORITY =
  "online_parent_process_replay_compare_and_set_support_only_not_gpu_hmr_acceptance";
const CLIENT_PROOF_AUTHORITY =
  "signed_online_parent_process_replay_client_support_only_not_gpu_hmr_acceptance";
const RESPONSE_ALGORITHM = "ed25519";
const RESPONSE_KEY_ID_PREFIX =
  "gpu-hmr-mcp-online-replay-response-key:sha256:";
const AUTHORITY_ID_PREFIX = "gpu-hmr-mcp-replay-authority:sha256:";
const GENERATION_ID_PREFIX =
  "gpu-hmr-mcp-online-replay-generation:sha256:";
const PARENT_START_ID_PREFIX =
  "gpu-hmr-mcp-online-replay-parent-start:sha256:";
const RECEIPT_ID_PREFIX = "gpu-hmr-mcp-admission-receipt:sha256:";
const REPLAY_SCOPE_ID_PREFIX =
  "gpu-hmr-mcp-admission-replay-scope:sha256:";
const NONCE_HASH_PREFIX = "gpu-hmr-mcp-admission-nonce:sha256:";
const SIGNATURE_PREFIX = "ed25519:";
const REQUEST_HASH_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_online_replay_request_hash.v1";
const EXPECTED_BINDING_HASH_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_online_replay_expected_binding_hash.v1";
const POLICY_HASH_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_online_replay_policy_hash.v1";
const RESPONSE_SIGNING_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_online_replay_response_signing.v1";
const PROBE_REQUEST_HASH_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_online_replay_probe_request_hash.v1";
const PROBE_RESPONSE_SIGNING_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_online_replay_probe_response_signing.v1";
const COMMIT_HASH_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_online_replay_commit_hash.v1";
const GENESIS_HASH_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_online_replay_genesis_hash.v1";
const REPLAY_SCOPE_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_receipt_replay_scope.v1";
const WIRE_REQUEST_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_online_replay_wire_request.v1";
const DEFAULT_MAX_AGE_NS = 30_000_000_000n;
const DEFAULT_MAX_FUTURE_SKEW_NS = 1_000_000_000n;
const DEFAULT_MAX_SCOPES = 4_096;
const DEFAULT_MAX_RECEIPTS_PER_SCOPE = 65_536;
const DEFAULT_MAX_OPERATIONS = 131_072;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const MAX_OPERATION_TIMEOUT_MS = 60_000;
const HARD_MAX_SCOPES = 65_536;
const HARD_MAX_RECEIPTS_PER_SCOPE = 65_536;
const HARD_MAX_OPERATIONS = 262_144;
const MAX_CONCURRENT_CONNECTIONS = 128;
const MAX_REQUEST_FRAME_BYTES = 64 * 1024;
const MAX_RESPONSE_FRAME_BYTES = 32 * 1024;
const MAX_JSON_DEPTH = 8;
const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_PROCESS_ID = 0xffff_ffff;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const AUTHORITY_ID_PATTERN =
  /^gpu-hmr-mcp-replay-authority:sha256:[a-f0-9]{64}$/;
const GENERATION_ID_PATTERN =
  /^gpu-hmr-mcp-online-replay-generation:sha256:[a-f0-9]{64}$/;
const PARENT_START_ID_PATTERN =
  /^gpu-hmr-mcp-online-replay-parent-start:sha256:[a-f0-9]{64}$/;
const RECEIPT_ID_PATTERN =
  /^gpu-hmr-mcp-admission-receipt:sha256:[a-f0-9]{64}$/;
const REPLAY_SCOPE_ID_PATTERN =
  /^gpu-hmr-mcp-admission-replay-scope:sha256:[a-f0-9]{64}$/;
const NONCE_HASH_PATTERN =
  /^gpu-hmr-mcp-admission-nonce:sha256:[a-f0-9]{64}$/;
const CANONICAL_U64_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

const START_REQUIRED_OPTION_KEYS = Object.freeze([
  "trustedVerificationKey",
  "validationRunChallenge",
]);
const START_OPTIONAL_OPTION_KEYS = Object.freeze([
  "maxAgeNs",
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
  "maxOperations",
  "operationTimeoutMs",
]);
const EXPECTED_BINDING_KEYS = Object.freeze([
  "transportSessionId",
  "compileRequestNonce",
  "computeExpectedOutputContractHash",
  "computeExpectedOutputSemanticsHash",
  "artifactContentHash",
  "fullRuntimeProofId",
  "proofLedgerId",
  "runnerRuntimeSessionId",
]);
const POLICY_KEYS = Object.freeze([
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
]);
const REQUEST_KEYS = Object.freeze([
  "schemaVersion",
  "authorityId",
  "replayOperationId",
  "expectedBindingHash",
  "requestId",
  "receipt",
]);
const WIRE_REQUEST_KEYS = Object.freeze([
  "schemaVersion",
  "authorityGenerationId",
  "request",
]);
const PROBE_REQUEST_KEYS = Object.freeze([
  "schemaVersion",
  "authorityId",
  "authorityGenerationId",
  "responseKeyId",
  "policyHash",
  "probeId",
]);
const RESPONSE_KEY_KEYS = Object.freeze([
  "schemaVersion",
  "algorithm",
  "keyId",
  "publicKey",
]);
const SERVER_PROJECTION_KEYS = Object.freeze([
  "authorityId",
  "authorityGenerationId",
  "responseVerificationKey",
  "endpoint",
  "parentPid",
  "parentStartIdentity",
  "transport",
  "operationTimeoutMs",
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
  "policyHash",
]);
const RESPONSE_UNSIGNED_KEYS = Object.freeze([
  "schemaVersion",
  "authorityId",
  "authorityGenerationId",
  "responseKeyId",
  "parentPid",
  "parentStartIdentity",
  "requestId",
  "requestHash",
  "replayOperationId",
  "outcome",
  "reason",
  "durable",
  "authorityClass",
  "rollbackProtected",
  "onlineRequired",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
  "policyHash",
  "receiptId",
  "replayScopeId",
  "sequence",
  "nonceHash",
  "revision",
  "committedAtUnixNs",
  "operationCommitted",
  "previousCommitHash",
  "commitHash",
]);
const RESPONSE_KEYS = Object.freeze([
  ...RESPONSE_UNSIGNED_KEYS,
  "signature",
]);
const PROBE_RESPONSE_UNSIGNED_KEYS = Object.freeze([
  "schemaVersion",
  "authorityId",
  "authorityGenerationId",
  "responseKeyId",
  "parentPid",
  "parentStartIdentity",
  "probeId",
  "probeHash",
  "authorityClass",
  "rollbackProtected",
  "onlineRequired",
  "durable",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
  "policyHash",
  "revision",
  "commitHash",
  "observedAtUnixNs",
]);
const PROBE_RESPONSE_KEYS = Object.freeze([
  ...PROBE_RESPONSE_UNSIGNED_KEYS,
  "signature",
]);
const COMMITMENT_KEYS = Object.freeze([
  "authorityId",
  "authorityGenerationId",
  "revision",
  "previousCommitHash",
  "requestId",
  "requestHash",
  "replayOperationId",
  "outcome",
  "reason",
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
  "policyHash",
  "receiptId",
  "replayScopeId",
  "sequence",
  "nonceHash",
  "committedAtUnixNs",
]);
const VERIFIER_REJECTION_REASONS = new Set([
  "gpu_hmr_mcp_admission_verification_key_invalid",
  "gpu_hmr_mcp_admission_expected_challenge_invalid",
  "gpu_hmr_mcp_admission_receipt_shape_invalid",
  "gpu_hmr_mcp_admission_signer_key_mismatch",
  "gpu_hmr_mcp_admission_validation_run_challenge_mismatch",
  "gpu_hmr_mcp_admission_receipt_id_mismatch",
  "gpu_hmr_mcp_admission_signature_mismatch",
]);
const RESPONSE_REJECTION_REASONS = new Set([
  ...VERIFIER_REJECTION_REASONS,
  "gpu_hmr_mcp_admission_signed_binding_mismatch",
  "gpu_hmr_mcp_admission_receipt_too_early_at_replay_commit",
  "gpu_hmr_mcp_admission_receipt_expired_before_replay_commit",
  "gpu_hmr_mcp_admission_receipt_replayed",
  "gpu_hmr_mcp_admission_sequence_not_increasing",
  "gpu_hmr_mcp_admission_nonce_replayed",
  "gpu_hmr_mcp_admission_replay_scope_capacity_exhausted",
  "gpu_hmr_mcp_admission_replay_scope_receipt_capacity_exhausted",
  "gpu_hmr_mcp_admission_replay_operation_capacity_exhausted",
  "gpu_hmr_mcp_admission_replay_operation_id_conflict",
  "gpu_hmr_mcp_admission_replay_revision_exhausted",
]);
const UNCOMMITTED_REASONS = new Set([
  "gpu_hmr_mcp_admission_replay_operation_capacity_exhausted",
  "gpu_hmr_mcp_admission_replay_operation_id_conflict",
  "gpu_hmr_mcp_admission_replay_revision_exhausted",
]);

const serverStates = new WeakMap();
const clientStates = new WeakMap();
const MONOTONIC_CLOCK_ANCHOR_NS = process.hrtime.bigint();
const UNIX_CLOCK_ANCHOR_NS = BigInt(Date.now()) * 1_000_000n;

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function domainSha256(domain, value) {
  return `sha256:${createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value)
    .digest("hex")}`;
}

function prefixedRandomId(prefix, domain) {
  const seed = randomBytes(32);
  try {
    const digest = createHash("sha256")
      .update(domain, "utf8")
      .update("\0", "utf8")
      .update(seed)
      .digest("hex");
    return `${prefix}${digest}`;
  } finally {
    seed.fill(0);
  }
}

const PARENT_START_IDENTITY = prefixedRandomId(
  PARENT_START_ID_PREFIX,
  "synthi.gpu_hmr.mcp_admission_online_replay_parent_start.v1",
);

function snapshotDataObject(value, requiredKeys, optionalKeys = []) {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) {
      return null;
    }
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    const required = new Set(requiredKeys);
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
      || [...required].some((key) => !ownKeys.includes(key))
    ) {
      return null;
    }
    const snapshot = {};
    for (const key of ownKeys) {
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
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotExactDataObject(value, keys) {
  const snapshot = snapshotDataObject(value, keys);
  return snapshot !== null && Reflect.ownKeys(snapshot).length === keys.length
    ? snapshot
    : null;
}

function canonicalJson(value) {
  const ancestors = new Set();
  function encode(current, depth) {
    if (depth > MAX_JSON_DEPTH) throw new Error("json_depth_exceeded");
    if (current === null) return "null";
    if (typeof current === "string" || typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current) || Object.is(current, -0)) {
        throw new Error("json_number_invalid");
      }
      return String(current);
    }
    if (typeof current !== "object" || isProxy(current)) {
      throw new Error("json_value_invalid");
    }
    if (Array.isArray(current) || Object.getPrototypeOf(current) !== Object.prototype) {
      throw new Error("json_object_invalid");
    }
    if (ancestors.has(current)) throw new Error("json_cycle");
    ancestors.add(current);
    try {
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some((key) => typeof key !== "string")) {
        throw new Error("json_key_invalid");
      }
      const keys = ownKeys.sort();
      const entries = [];
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined
          || descriptor.enumerable !== true
          || !Object.prototype.hasOwnProperty.call(descriptor, "value")
          || Object.prototype.hasOwnProperty.call(descriptor, "get")
          || Object.prototype.hasOwnProperty.call(descriptor, "set")
        ) {
          throw new Error("json_property_invalid");
        }
        entries.push(`${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`);
      }
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  }
  try {
    return encode(value, 0);
  } catch {
    return null;
  }
}

function canonicalToken(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[\x21-\x7e]+$/.test(value);
}

function canonicalU64String(value, positive = false) {
  if (
    typeof value !== "string"
    || value.length > U64_MAX.toString().length
    || !CANONICAL_U64_PATTERN.test(value)
  ) {
    return false;
  }
  try {
    const parsed = BigInt(value);
    return parsed <= U64_MAX && (!positive || parsed > 0n);
  } catch {
    return false;
  }
}

function canonicalUnixNs(value, positive = false) {
  return typeof value === "bigint"
    && value >= (positive ? 1n : 0n)
    && value <= U64_MAX;
}

function boundedPositiveInteger(value, maximum) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= maximum;
}

function decodeCanonicalBase64Url(value, byteLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
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

function responseVerificationKey(publicKeyObject) {
  const exported = publicKeyObject.export({ format: "der", type: "spki" });
  const der = Buffer.isBuffer(exported) ? exported : Buffer.from(exported);
  if (
    der.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32
    || !der.subarray(0, ED25519_SPKI_PREFIX.byteLength)
      .equals(ED25519_SPKI_PREFIX)
  ) {
    throw onlineReplayError("response_key_generation_failed");
  }
  const raw = der.subarray(ED25519_SPKI_PREFIX.byteLength);
  return Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_RESPONSE_KEY_SCHEMA,
    algorithm: RESPONSE_ALGORITHM,
    keyId: `${RESPONSE_KEY_ID_PREFIX}${sha256Hex(raw)}`,
    publicKey: raw.toString("base64url"),
  });
}

function parseResponseVerificationKey(value) {
  const snapshot = snapshotExactDataObject(value, RESPONSE_KEY_KEYS);
  if (
    snapshot === null
    || snapshot.schemaVersion
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_RESPONSE_KEY_SCHEMA
    || snapshot.algorithm !== RESPONSE_ALGORITHM
  ) {
    return null;
  }
  const raw = decodeCanonicalBase64Url(snapshot.publicKey, 32);
  if (
    raw === null
    || snapshot.keyId !== `${RESPONSE_KEY_ID_PREFIX}${sha256Hex(raw)}`
  ) {
    return null;
  }
  try {
    const keyObject = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return Object.freeze({
      projection: Object.freeze({ ...snapshot }),
      keyObject,
    });
  } catch {
    return null;
  }
}

function onlineReplayError(reason, cause, indeterminate = false) {
  const error = new Error(
    `gpu_hmr_mcp_admission_online_replay_${reason}`,
    cause === undefined ? undefined : { cause },
  );
  error.code = `GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_${reason.toUpperCase()}`;
  if (indeterminate) {
    error.outcome = "indeterminate";
    error.failClosed = true;
  }
  return error;
}

function abortError() {
  const error = onlineReplayError("operation_aborted", undefined, true);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function currentUnixNs() {
  const elapsedNs = process.hrtime.bigint() - MONOTONIC_CLOCK_ANCHOR_NS;
  const unixNs = UNIX_CLOCK_ANCHOR_NS + elapsedNs;
  return unixNs > U64_MAX ? U64_MAX : unixNs;
}

function expectedBindingSnapshot(value) {
  const snapshot = snapshotExactDataObject(value, EXPECTED_BINDING_KEYS);
  if (snapshot === null) return null;
  if (
    !canonicalToken(snapshot.transportSessionId)
    || !canonicalToken(snapshot.compileRequestNonce)
    || !(
      snapshot.computeExpectedOutputContractHash === null
      || SHA256_PATTERN.test(snapshot.computeExpectedOutputContractHash)
    )
    || !(
      snapshot.computeExpectedOutputSemanticsHash === null
      || SHA256_PATTERN.test(snapshot.computeExpectedOutputSemanticsHash)
    )
    || typeof snapshot.artifactContentHash !== "string"
    || !SHA256_PATTERN.test(snapshot.artifactContentHash)
    || !canonicalToken(snapshot.fullRuntimeProofId)
    || !canonicalToken(snapshot.proofLedgerId)
    || !canonicalToken(snapshot.runnerRuntimeSessionId)
  ) {
    return null;
  }
  return snapshot;
}

export function hashGpuHmrMcpAdmissionOnlineReplayExpectedBinding(value) {
  const snapshot = expectedBindingSnapshot(value);
  if (snapshot === null) return null;
  const encoded = canonicalJson(snapshot);
  return encoded === null
    ? null
    : domainSha256(EXPECTED_BINDING_HASH_DOMAIN, encoded);
}

function policySnapshot(value) {
  const snapshot = snapshotExactDataObject(value, POLICY_KEYS);
  if (
    snapshot === null
    || !canonicalU64String(snapshot.maxReceiptAgeNs, true)
    || !canonicalU64String(snapshot.maxFutureSkewNs)
    || !boundedPositiveInteger(snapshot.maxScopes, HARD_MAX_SCOPES)
    || !boundedPositiveInteger(
      snapshot.maxReceiptsPerScope,
      HARD_MAX_RECEIPTS_PER_SCOPE,
    )
  ) {
    return null;
  }
  return snapshot;
}

export function hashGpuHmrMcpAdmissionOnlineReplayPolicy(value) {
  const snapshot = policySnapshot(value);
  if (snapshot === null) return null;
  const encoded = canonicalJson(snapshot);
  return encoded === null ? null : domainSha256(POLICY_HASH_DOMAIN, encoded);
}

function createPolicyProjection(
  maxReceiptAgeNs,
  maxFutureSkewNs,
  maxScopes,
  maxReceiptsPerScope,
) {
  const policy = Object.freeze({
    maxReceiptAgeNs: maxReceiptAgeNs.toString(),
    maxFutureSkewNs: maxFutureSkewNs.toString(),
    maxScopes,
    maxReceiptsPerScope,
  });
  const policyHash = hashGpuHmrMcpAdmissionOnlineReplayPolicy(policy);
  if (policyHash === null) throw onlineReplayError("policy_encoding_failed");
  return Object.freeze({ ...policy, policyHash });
}

function expectedBindingHashFromReceipt(receipt) {
  const binding = {};
  for (const key of EXPECTED_BINDING_KEYS) binding[key] = receipt[key];
  return hashGpuHmrMcpAdmissionOnlineReplayExpectedBinding(binding);
}

function replayScopeIdFromReceipt(receipt) {
  if (
    typeof receipt?.signerKeyId !== "string"
    || typeof receipt?.validationRunChallengeSha256 !== "string"
    || typeof receipt?.transportSessionId !== "string"
  ) {
    return null;
  }
  const digest = sha256Hex(JSON.stringify([
    REPLAY_SCOPE_DOMAIN,
    receipt.signerKeyId,
    receipt.validationRunChallengeSha256,
    receipt.transportSessionId,
  ]));
  return `${REPLAY_SCOPE_ID_PREFIX}${digest}`;
}

function nonceHashFromReceipt(receipt) {
  if (typeof receipt?.nonce !== "string") return null;
  const digest = createHash("sha256")
    .update("gpu-hmr-mcp-admission-nonce", "utf8")
    .update("\0", "utf8")
    .update(receipt.nonce, "utf8")
    .digest("hex");
  return `${NONCE_HASH_PREFIX}${digest}`;
}

function deriveReceiptClaims(receipt) {
  if (
    receipt === null
    || typeof receipt !== "object"
    || isProxy(receipt)
    || Array.isArray(receipt)
    || Object.getPrototypeOf(receipt) !== Object.prototype
  ) {
    return Object.freeze({
      receiptId: null,
      replayScopeId: null,
      sequence: null,
      nonceHash: null,
    });
  }
  return Object.freeze({
    receiptId: RECEIPT_ID_PATTERN.test(receipt.receiptId ?? "")
      ? receipt.receiptId
      : null,
    replayScopeId: replayScopeIdFromReceipt(receipt),
    sequence: canonicalU64String(receipt.sequence, true)
      ? receipt.sequence
      : null,
    nonceHash: nonceHashFromReceipt(receipt),
  });
}

function requestSnapshot(value, expectedAuthorityId) {
  const snapshot = snapshotExactDataObject(value, REQUEST_KEYS);
  if (
    snapshot === null
    || snapshot.schemaVersion
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_REQUEST_SCHEMA
    || snapshot.authorityId !== expectedAuthorityId
    || !AUTHORITY_ID_PATTERN.test(snapshot.authorityId)
    || !canonicalToken(snapshot.replayOperationId)
    || typeof snapshot.expectedBindingHash !== "string"
    || !SHA256_PATTERN.test(snapshot.expectedBindingHash)
    || !canonicalToken(snapshot.requestId)
    || canonicalJson(snapshot.receipt) === null
  ) {
    return null;
  }
  return snapshot;
}

function requestHash(request) {
  const encoded = canonicalJson(request);
  if (encoded === null) throw onlineReplayError("request_invalid");
  return domainSha256(REQUEST_HASH_DOMAIN, encoded);
}

function probeRequestHash(request) {
  const encoded = canonicalJson(request);
  if (encoded === null) throw onlineReplayError("probe_request_invalid");
  return domainSha256(PROBE_REQUEST_HASH_DOMAIN, encoded);
}

function parseStartOptions(value) {
  const snapshot = snapshotDataObject(
    value,
    START_REQUIRED_OPTION_KEYS,
    START_OPTIONAL_OPTION_KEYS,
  );
  if (snapshot === null) throw onlineReplayError("server_options_invalid");
  const trustedVerificationKey = parseGpuHmrMcpAdmissionVerificationKey(
    snapshot.trustedVerificationKey,
  );
  if (trustedVerificationKey === null) {
    throw onlineReplayError("trusted_verification_key_invalid");
  }
  if (hashGpuHmrMcpValidationRunChallenge(
    snapshot.validationRunChallenge,
  ) === null) {
    throw onlineReplayError("validation_run_challenge_invalid");
  }
  if (
    Object.prototype.hasOwnProperty.call(snapshot, "maxAgeNs")
    && Object.prototype.hasOwnProperty.call(snapshot, "maxReceiptAgeNs")
  ) {
    throw onlineReplayError("freshness_policy_invalid");
  }
  const maxAgeNs = snapshot.maxReceiptAgeNs
    ?? snapshot.maxAgeNs
    ?? DEFAULT_MAX_AGE_NS;
  const maxFutureSkewNs =
    snapshot.maxFutureSkewNs ?? DEFAULT_MAX_FUTURE_SKEW_NS;
  const maxScopes = snapshot.maxScopes ?? DEFAULT_MAX_SCOPES;
  const maxReceiptsPerScope =
    snapshot.maxReceiptsPerScope ?? DEFAULT_MAX_RECEIPTS_PER_SCOPE;
  const maxOperations = snapshot.maxOperations ?? DEFAULT_MAX_OPERATIONS;
  const operationTimeoutMs =
    snapshot.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!canonicalUnixNs(maxAgeNs, true) || !canonicalUnixNs(maxFutureSkewNs)) {
    throw onlineReplayError("freshness_policy_invalid");
  }
  if (
    !boundedPositiveInteger(maxScopes, HARD_MAX_SCOPES)
    || !boundedPositiveInteger(
      maxReceiptsPerScope,
      HARD_MAX_RECEIPTS_PER_SCOPE,
    )
    || !boundedPositiveInteger(maxOperations, HARD_MAX_OPERATIONS)
  ) {
    throw onlineReplayError("capacity_policy_invalid");
  }
  if (!boundedPositiveInteger(operationTimeoutMs, MAX_OPERATION_TIMEOUT_MS)) {
    throw onlineReplayError("operation_timeout_invalid");
  }
  return Object.freeze({
    trustedVerificationKey,
    validationRunChallenge: snapshot.validationRunChallenge,
    maxAgeNs,
    maxFutureSkewNs,
    maxScopes,
    maxReceiptsPerScope,
    maxOperations,
    operationTimeoutMs,
  });
}

function randomEndpoint() {
  const capability = randomBytes(32).toString("hex");
  return process.platform === "win32"
    ? Object.freeze({
      endpoint: `\\\\.\\pipe\\${capability}`,
      transport: "windows_named_pipe",
    })
    : Object.freeze({
      endpoint: path.join(os.tmpdir(), `${capability}.sock`),
      transport: "unix_domain_socket",
    });
}

function endpointAccepted(endpoint, transport) {
  if (process.platform === "win32") {
    return transport === "windows_named_pipe"
      && typeof endpoint === "string"
      && /^\\\\\.\\pipe\\[a-f0-9]{64}$/.test(endpoint);
  }
  try {
    return transport === "unix_domain_socket"
      && typeof endpoint === "string"
      && path.isAbsolute(endpoint)
      && path.normalize(endpoint) === endpoint
      && path.resolve(path.dirname(endpoint)) === path.resolve(os.tmpdir())
      && /^[a-f0-9]{64}\.sock$/.test(path.basename(endpoint));
  } catch {
    return false;
  }
}

function serverProjectionSnapshot(value) {
  const snapshot = snapshotExactDataObject(value, SERVER_PROJECTION_KEYS);
  const policy = snapshot === null ? null : policySnapshot({
    maxReceiptAgeNs: snapshot.maxReceiptAgeNs,
    maxFutureSkewNs: snapshot.maxFutureSkewNs,
    maxScopes: snapshot.maxScopes,
    maxReceiptsPerScope: snapshot.maxReceiptsPerScope,
  });
  if (
    snapshot === null
    || !AUTHORITY_ID_PATTERN.test(snapshot.authorityId ?? "")
    || !GENERATION_ID_PATTERN.test(snapshot.authorityGenerationId ?? "")
    || !PARENT_START_ID_PATTERN.test(snapshot.parentStartIdentity ?? "")
    || !boundedPositiveInteger(snapshot.parentPid, MAX_PROCESS_ID)
    || !endpointAccepted(snapshot.endpoint, snapshot.transport)
    || !boundedPositiveInteger(
      snapshot.operationTimeoutMs,
      MAX_OPERATION_TIMEOUT_MS,
    )
    || policy === null
    || snapshot.policyHash
      !== hashGpuHmrMcpAdmissionOnlineReplayPolicy(policy)
  ) {
    return null;
  }
  const parsedKey = parseResponseVerificationKey(
    snapshot.responseVerificationKey,
  );
  if (parsedKey === null) return null;
  return Object.freeze({
    projection: Object.freeze({
      ...snapshot,
      responseVerificationKey: parsedKey.projection,
    }),
    responsePublicKey: parsedKey.keyObject,
  });
}

function frameFor(value, maximumBytes) {
  const encoded = canonicalJson(value);
  if (encoded === null) return null;
  const frame = Buffer.from(`${encoded}\n`, "utf8");
  return frame.byteLength <= maximumBytes ? frame : null;
}

function parseFrame(buffer, maximumBytes) {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.byteLength < 3
    || buffer.byteLength > maximumBytes
    || buffer[buffer.byteLength - 1] !== 0x0a
    || buffer.indexOf(0x0a) !== buffer.byteLength - 1
  ) {
    return null;
  }
  try {
    const body = UTF8_DECODER.decode(buffer.subarray(0, -1));
    const parsed = JSON.parse(body);
    return canonicalJson(parsed) === body ? parsed : null;
  } catch {
    return null;
  }
}

function commitmentProjection(response) {
  const projection = {};
  for (const key of COMMITMENT_KEYS) projection[key] = response[key];
  return projection;
}

function commitHash(response) {
  const encoded = canonicalJson(commitmentProjection(response));
  if (encoded === null) throw onlineReplayError("commit_encoding_failed");
  return domainSha256(COMMIT_HASH_DOMAIN, encoded);
}

function responseSigningBytes(unsignedResponse) {
  const encoded = canonicalJson(unsignedResponse);
  if (encoded === null) throw onlineReplayError("response_encoding_failed");
  return Buffer.from(`${RESPONSE_SIGNING_DOMAIN}\0${encoded}`, "utf8");
}

function probeResponseSigningBytes(unsignedResponse) {
  const encoded = canonicalJson(unsignedResponse);
  if (encoded === null) throw onlineReplayError("probe_response_encoding_failed");
  return Buffer.from(`${PROBE_RESPONSE_SIGNING_DOMAIN}\0${encoded}`, "utf8");
}

function signResponse(state, unsignedResponse) {
  if (state.responsePrivateKey === null) {
    throw onlineReplayError("response_signer_unavailable");
  }
  const signature = signBytes(
    null,
    responseSigningBytes(unsignedResponse),
    state.responsePrivateKey,
  );
  return Object.freeze({
    ...unsignedResponse,
    signature: `${SIGNATURE_PREFIX}${signature.toString("base64url")}`,
  });
}

function signProbeResponse(state, unsignedResponse) {
  if (state.responsePrivateKey === null) {
    throw onlineReplayError("response_signer_unavailable");
  }
  const signature = signBytes(
    null,
    probeResponseSigningBytes(unsignedResponse),
    state.responsePrivateKey,
  );
  return Object.freeze({
    ...unsignedResponse,
    signature: `${SIGNATURE_PREFIX}${signature.toString("base64url")}`,
  });
}

function responseBase(state, request, requestDigest, claims, details) {
  return {
    schemaVersion: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_RESPONSE_SCHEMA,
    authorityId: state.authorityId,
    authorityGenerationId: state.authorityGenerationId,
    responseKeyId: state.responseVerificationKey.keyId,
    parentPid: process.pid,
    parentStartIdentity: PARENT_START_IDENTITY,
    requestId: request.requestId,
    requestHash: requestDigest,
    replayOperationId: request.replayOperationId,
    outcome: details.reason === null ? "applied" : "rejected",
    reason: details.reason,
    durable: false,
    authorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
    rollbackProtected: true,
    onlineRequired: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    maxReceiptAgeNs: state.policy.maxReceiptAgeNs,
    maxFutureSkewNs: state.policy.maxFutureSkewNs,
    maxScopes: state.policy.maxScopes,
    maxReceiptsPerScope: state.policy.maxReceiptsPerScope,
    policyHash: state.policy.policyHash,
    receiptId: claims.receiptId,
    replayScopeId: claims.replayScopeId,
    sequence: claims.sequence,
    nonceHash: claims.nonceHash,
    revision: details.revision.toString(),
    committedAtUnixNs: details.committedAtUnixNs.toString(),
    operationCommitted: details.operationCommitted,
    previousCommitHash: details.previousCommitHash,
    commitHash: details.commitHash,
  };
}

function createCommittedResponse(
  state,
  request,
  requestDigest,
  claims,
  reason,
  committedAtUnixNs,
) {
  const revision = state.revision + 1n;
  const partial = responseBase(state, request, requestDigest, claims, {
    reason,
    revision,
    committedAtUnixNs,
    operationCommitted: true,
    previousCommitHash: state.commitHash,
    commitHash: SHA256_PATTERN.source,
  });
  partial.commitHash = commitHash(partial);
  return signResponse(state, Object.freeze(partial));
}

function createUncommittedResponse(
  state,
  request,
  requestDigest,
  claims,
  reason,
  committedAtUnixNs,
) {
  return signResponse(state, Object.freeze(responseBase(
    state,
    request,
    requestDigest,
    claims,
    {
      reason,
      revision: state.revision,
      committedAtUnixNs,
      operationCommitted: false,
      previousCommitHash: state.commitHash,
      commitHash: state.commitHash,
    },
  )));
}

function replayFailure(state, claims) {
  const scope = state.scopes.get(claims.replayScopeId);
  if (scope?.receiptIds.has(claims.receiptId)) {
    return "gpu_hmr_mcp_admission_receipt_replayed";
  }
  const sequence = BigInt(claims.sequence);
  if (scope !== undefined && sequence <= scope.highestSequence) {
    return "gpu_hmr_mcp_admission_sequence_not_increasing";
  }
  if (scope?.nonceHashes.has(claims.nonceHash)) {
    return "gpu_hmr_mcp_admission_nonce_replayed";
  }
  if (scope === undefined) {
    if (state.scopes.size >= state.maxScopes) {
      return "gpu_hmr_mcp_admission_replay_scope_capacity_exhausted";
    }
  } else if (scope.receiptIds.size >= state.maxReceiptsPerScope) {
    return "gpu_hmr_mcp_admission_replay_scope_receipt_capacity_exhausted";
  }
  return null;
}

function applyReplay(state, claims) {
  const sequence = BigInt(claims.sequence);
  const scope = state.scopes.get(claims.replayScopeId);
  if (scope === undefined) {
    state.scopes.set(claims.replayScopeId, {
      highestSequence: sequence,
      receiptIds: new Set([claims.receiptId]),
      nonceHashes: new Set([claims.nonceHash]),
    });
    return;
  }
  scope.highestSequence = sequence;
  scope.receiptIds.add(claims.receiptId);
  scope.nonceHashes.add(claims.nonceHash);
}

function freshnessFailure(state, admittedAtUnixNs, nowUnixNs) {
  if (
    admittedAtUnixNs > nowUnixNs
    && admittedAtUnixNs - nowUnixNs > state.maxFutureSkewNs
  ) {
    return "gpu_hmr_mcp_admission_receipt_too_early_at_replay_commit";
  }
  if (
    nowUnixNs > admittedAtUnixNs
    && nowUnixNs - admittedAtUnixNs > state.maxAgeNs
  ) {
    return "gpu_hmr_mcp_admission_receipt_expired_before_replay_commit";
  }
  return null;
}

function processRequest(state, request) {
  const requestDigest = requestHash(request);
  const claims = deriveReceiptClaims(request.receipt);
  const prior = state.operations.get(request.replayOperationId);
  const committedAtUnixNs = currentUnixNs();
  if (prior !== undefined) {
    if (prior.requestHash === requestDigest) return prior.response;
    if (prior.conflictRequestHash === requestDigest) {
      return prior.conflictResponse;
    }
    const conflictResponse = createUncommittedResponse(
      state,
      request,
      requestDigest,
      claims,
      "gpu_hmr_mcp_admission_replay_operation_id_conflict",
      committedAtUnixNs,
    );
    if (prior.conflictRequestHash === null) {
      prior.conflictRequestHash = requestDigest;
      prior.conflictResponse = conflictResponse;
    }
    return conflictResponse;
  }
  if (state.operations.size >= state.maxOperations) {
    return createUncommittedResponse(
      state,
      request,
      requestDigest,
      claims,
      "gpu_hmr_mcp_admission_replay_operation_capacity_exhausted",
      state.operationCapacityReachedAtUnixNs ?? committedAtUnixNs,
    );
  }
  if (state.revision >= U64_MAX) {
    return createUncommittedResponse(
      state,
      request,
      requestDigest,
      claims,
      "gpu_hmr_mcp_admission_replay_revision_exhausted",
      committedAtUnixNs,
    );
  }

  const verification = verifyGpuHmrMcpAdmissionReceipt(
    state.trustedVerificationKey,
    request.receipt,
    state.validationRunChallenge,
  );
  let reason = verification?.verified === true
    ? null
    : verification?.reason
      ?? "gpu_hmr_mcp_admission_receipt_shape_invalid";
  if (reason === null) {
    if (
      claims.receiptId !== verification.receiptId
      || claims.replayScopeId !== verification.replayScope.replayScopeId
      || claims.sequence !== verification.sequence.toString()
      || claims.nonceHash === null
    ) {
      reason = "gpu_hmr_mcp_admission_receipt_shape_invalid";
    }
  }
  if (reason === null) {
    const bindingHash = expectedBindingHashFromReceipt(request.receipt);
    if (bindingHash === null || bindingHash !== request.expectedBindingHash) {
      reason = "gpu_hmr_mcp_admission_signed_binding_mismatch";
    }
  }
  if (reason === null) {
    reason = freshnessFailure(
      state,
      verification.admittedAtUnixNs,
      committedAtUnixNs,
    );
  }
  if (reason === null) reason = replayFailure(state, claims);
  if (!RESPONSE_REJECTION_REASONS.has(reason) && reason !== null) {
    reason = "gpu_hmr_mcp_admission_receipt_shape_invalid";
  }

  const response = createCommittedResponse(
    state,
    request,
    requestDigest,
    claims,
    reason,
    committedAtUnixNs,
  );
  if (reason === null) applyReplay(state, claims);
  state.revision = BigInt(response.revision);
  state.commitHash = response.commitHash;
  state.operations.set(request.replayOperationId, Object.seal({
    requestHash: requestDigest,
    response,
    conflictRequestHash: null,
    conflictResponse: null,
  }));
  if (
    state.operations.size >= state.maxOperations
    && state.operationCapacityReachedAtUnixNs === null
  ) {
    state.operationCapacityReachedAtUnixNs = committedAtUnixNs;
  }
  return response;
}

function processWireRequest(state, wireValue) {
  const wire = snapshotExactDataObject(wireValue, WIRE_REQUEST_KEYS);
  if (
    wire === null
    || wire.schemaVersion !== WIRE_REQUEST_SCHEMA
    || wire.authorityGenerationId !== state.authorityGenerationId
  ) {
    return null;
  }
  const request = requestSnapshot(wire.request, state.authorityId);
  return request === null ? null : processRequest(state, request);
}

function processProbeRequest(state, value) {
  const request = snapshotExactDataObject(value, PROBE_REQUEST_KEYS);
  if (
    request === null
    || request.schemaVersion
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_REQUEST_SCHEMA
    || request.authorityId !== state.authorityId
    || request.authorityGenerationId !== state.authorityGenerationId
    || request.responseKeyId !== state.responseVerificationKey.keyId
    || request.policyHash !== state.policy.policyHash
    || decodeCanonicalBase64Url(request.probeId, 32) === null
  ) {
    return null;
  }
  return signProbeResponse(state, Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA,
    authorityId: state.authorityId,
    authorityGenerationId: state.authorityGenerationId,
    responseKeyId: state.responseVerificationKey.keyId,
    parentPid: process.pid,
    parentStartIdentity: PARENT_START_IDENTITY,
    probeId: request.probeId,
    probeHash: probeRequestHash(request),
    authorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
    rollbackProtected: true,
    onlineRequired: true,
    durable: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    maxReceiptAgeNs: state.policy.maxReceiptAgeNs,
    maxFutureSkewNs: state.policy.maxFutureSkewNs,
    maxScopes: state.policy.maxScopes,
    maxReceiptsPerScope: state.policy.maxReceiptsPerScope,
    policyHash: state.policy.policyHash,
    revision: state.revision.toString(),
    commitHash: state.commitHash,
    observedAtUnixNs: currentUnixNs().toString(),
  }));
}

function processWireMessage(state, value) {
  return processWireRequest(state, value) ?? processProbeRequest(state, value);
}

function handleConnection(state, socket) {
  if (
    state.disposed
    || !state.accepting
    || state.connections.size >= MAX_CONCURRENT_CONNECTIONS
  ) {
    socket.destroy();
    return;
  }
  state.connections.add(socket);
  const chunks = [];
  let receivedBytes = 0;
  let invalid = false;
  let newlineSeen = false;
  let processingScheduled = false;
  let finished = false;
  const processFrame = () => {
    processingScheduled = false;
    if (invalid || finished || state.disposed || !newlineSeen) {
      if (!finished) socket.destroy();
      return;
    }
    finished = true;
    socket.setTimeout(0);
    const parsed = parseFrame(
      Buffer.concat(chunks, receivedBytes),
      MAX_REQUEST_FRAME_BYTES,
    );
    const response = parsed === null ? null : processWireMessage(state, parsed);
    const responseFrame = response === null
      ? null
      : frameFor(response, MAX_RESPONSE_FRAME_BYTES);
    if (responseFrame === null) {
      socket.destroy();
      return;
    }
    socket.end(responseFrame);
  };
  socket.setTimeout(Math.max(100, state.operationTimeoutMs), () => {
    invalid = true;
    socket.destroy();
  });
  socket.on("data", (chunk) => {
    if (invalid || finished) {
      invalid = true;
      socket.destroy();
      return;
    }
    receivedBytes += chunk.byteLength;
    if (receivedBytes > MAX_REQUEST_FRAME_BYTES) {
      invalid = true;
      socket.destroy();
      return;
    }
    chunks.push(Buffer.from(chunk));
    const firstNewline = chunk.indexOf(0x0a);
    if (firstNewline === -1) {
      if (newlineSeen) {
        invalid = true;
        socket.destroy();
      }
      return;
    }
    if (
      newlineSeen
      || firstNewline !== chunk.byteLength - 1
      || chunk.lastIndexOf(0x0a) !== firstNewline
    ) {
      invalid = true;
      socket.destroy();
      return;
    }
    newlineSeen = true;
    if (!processingScheduled) {
      processingScheduled = true;
      setImmediate(processFrame);
    }
  });
  socket.on("end", () => {
    if (invalid || state.disposed || !newlineSeen) {
      socket.destroy();
      return;
    }
    processFrame();
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    state.connections.delete(socket);
  });
}

async function removeOwnedUnixSocket(state) {
  if (state.transport !== "unix_domain_socket") return;
  try {
    const status = await lstat(state.endpoint);
    if (
      status.isSocket()
      && state.unixSocketIdentity !== null
      && status.dev === state.unixSocketIdentity.dev
      && status.ino === state.unixSocketIdentity.ino
    ) {
      await unlink(state.endpoint);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      // The random endpoint is transport-only; an unexpected replacement is left alone.
    }
  }
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function serverPublicValue(authorityId) {
  return Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_SERVER_SCHEMA,
    proofAuthority: SERVER_PROOF_AUTHORITY,
    authorityId,
    authorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
    rollbackProtected: true,
    onlineRequired: true,
    durable: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

export async function startGpuHmrMcpAdmissionOnlineReplayAuthorityServer(
  optionsValue,
) {
  const options = parseStartOptions(optionsValue);
  const authorityId = prefixedRandomId(
    AUTHORITY_ID_PREFIX,
    "synthi.gpu_hmr.mcp_admission_online_replay_authority_id.v1",
  );
  const authorityGenerationId = prefixedRandomId(
    GENERATION_ID_PREFIX,
    "synthi.gpu_hmr.mcp_admission_online_replay_generation_id.v1",
  );
  const endpointDetails = randomEndpoint();
  const responseKeys = generateKeyPairSync("ed25519");
  const responseKey = responseVerificationKey(responseKeys.publicKey);
  const policy = createPolicyProjection(
    options.maxAgeNs,
    options.maxFutureSkewNs,
    options.maxScopes,
    options.maxReceiptsPerScope,
  );
  const projection = Object.freeze({
    authorityId,
    authorityGenerationId,
    responseVerificationKey: responseKey,
    endpoint: endpointDetails.endpoint,
    parentPid: process.pid,
    parentStartIdentity: PARENT_START_IDENTITY,
    transport: endpointDetails.transport,
    operationTimeoutMs: options.operationTimeoutMs,
    ...policy,
  });
  const genesisMaterial = Object.freeze({
    authorityId,
    authorityGenerationId,
    responseKeyId: responseKey.keyId,
    parentPid: process.pid,
    parentStartIdentity: PARENT_START_IDENTITY,
    policyHash: policy.policyHash,
  });
  const encodedGenesis = canonicalJson(genesisMaterial);
  if (encodedGenesis === null) throw onlineReplayError("genesis_encoding_failed");
  const state = {
    authorityId,
    authorityGenerationId,
    endpoint: endpointDetails.endpoint,
    transport: endpointDetails.transport,
    operationTimeoutMs: options.operationTimeoutMs,
    trustedVerificationKey: options.trustedVerificationKey,
    validationRunChallenge: options.validationRunChallenge,
    maxAgeNs: options.maxAgeNs,
    maxFutureSkewNs: options.maxFutureSkewNs,
    maxScopes: options.maxScopes,
    maxReceiptsPerScope: options.maxReceiptsPerScope,
    maxOperations: options.maxOperations,
    policy,
    responsePrivateKey: responseKeys.privateKey,
    responseVerificationKey: responseKey,
    projection,
    scopes: new Map(),
    operations: new Map(),
    operationCapacityReachedAtUnixNs: null,
    revision: 0n,
    commitHash: domainSha256(GENESIS_HASH_DOMAIN, encodedGenesis),
    connections: new Set(),
    unixSocketIdentity: null,
    nodeServer: null,
    accepting: false,
    disposed: false,
  };
  const nodeServer = createServer({ allowHalfOpen: true }, (socket) => {
    handleConnection(state, socket);
  });
  state.nodeServer = nodeServer;
  nodeServer.on("error", () => {
    state.accepting = false;
  });
  try {
    await listen(nodeServer, state.endpoint);
    nodeServer.unref();
    if (state.transport === "unix_domain_socket") {
      const initialStatus = await lstat(state.endpoint);
      if (!initialStatus.isSocket()) {
        throw onlineReplayError("unix_socket_identity_invalid");
      }
      state.unixSocketIdentity = Object.freeze({
        dev: initialStatus.dev,
        ino: initialStatus.ino,
      });
      await chmod(state.endpoint, 0o600);
      const status = await lstat(state.endpoint);
      if (
        !status.isSocket()
        || status.dev !== state.unixSocketIdentity.dev
        || status.ino !== state.unixSocketIdentity.ino
        || (status.mode & 0o777) !== 0o600
      ) {
        throw onlineReplayError("unix_socket_permissions_invalid");
      }
    }
    state.accepting = true;
  } catch (error) {
    state.disposed = true;
    state.responsePrivateKey = null;
    for (const socket of state.connections) socket.destroy();
    await new Promise((resolve) => nodeServer.close(() => resolve()));
    await removeOwnedUnixSocket(state);
    throw onlineReplayError("server_start_failed", error);
  }

  const server = serverPublicValue(authorityId);
  serverStates.set(server, state);
  return server;
}

export function gpuHmrMcpAdmissionOnlineReplayAuthorityServerProjection(value) {
  return serverStates.get(value)?.projection ?? null;
}

export async function disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(
  value,
) {
  const state = serverStates.get(value);
  if (state === undefined || state.disposed) return false;
  state.disposed = true;
  state.accepting = false;
  state.responsePrivateKey = null;
  for (const socket of state.connections) socket.destroy();
  await new Promise((resolve) => {
    if (state.nodeServer === null || !state.nodeServer.listening) {
      resolve();
      return;
    }
    state.nodeServer.close(() => resolve());
  });
  await removeOwnedUnixSocket(state);
  return true;
}

function signalState(signal) {
  if (signal === undefined) return Object.freeze({ signal: null, aborted: false });
  if (
    signal === null
    || typeof signal !== "object"
    || isProxy(signal)
    || ABORTED_GETTER === undefined
  ) {
    throw onlineReplayError("abort_signal_invalid");
  }
  return Object.freeze({
    signal,
    aborted: nativeAbortSignalAborted(signal),
  });
}

function nativeAbortSignalAborted(signal) {
  try {
    return Reflect.apply(ABORTED_GETTER, signal, []) === true;
  } catch {
    throw onlineReplayError("abort_signal_invalid");
  }
}

function addAbortListener(signal, listener) {
  EventTarget.prototype.addEventListener.call(signal, "abort", listener, {
    once: true,
  });
}

function removeAbortListener(signal, listener) {
  EventTarget.prototype.removeEventListener.call(signal, "abort", listener);
}

function responseSnapshot(value) {
  return snapshotExactDataObject(value, RESPONSE_KEYS);
}

function validateResponseCommon(state, response, request, requestDigest, claims) {
  return response !== null
    && response.schemaVersion
      === GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_RESPONSE_SCHEMA
    && response.authorityId === state.metadata.authorityId
    && response.authorityGenerationId
      === state.metadata.authorityGenerationId
    && response.responseKeyId === state.responseVerificationKey.keyId
    && response.parentPid === state.metadata.parentPid
    && response.parentStartIdentity === state.metadata.parentStartIdentity
    && response.requestId === request.requestId
    && response.requestHash === requestDigest
    && response.replayOperationId === request.replayOperationId
    && response.durable === false
    && response.authorityClass
      === GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS
    && response.rollbackProtected === true
    && response.onlineRequired === true
    && response.acceptedForGpuHmr === false
    && response.gpuHmrSuccess === false
    && response.canSatisfyRuntimeProof === false
    && response.maxReceiptAgeNs === state.metadata.maxReceiptAgeNs
    && response.maxFutureSkewNs === state.metadata.maxFutureSkewNs
    && response.maxScopes === state.metadata.maxScopes
    && response.maxReceiptsPerScope
      === state.metadata.maxReceiptsPerScope
    && response.policyHash === state.metadata.policyHash
    && response.receiptId === claims.receiptId
    && response.replayScopeId === claims.replayScopeId
    && response.sequence === claims.sequence
    && response.nonceHash === claims.nonceHash
    && SHA256_PATTERN.test(response.requestHash ?? "")
    && canonicalU64String(response.revision)
    && canonicalU64String(response.committedAtUnixNs)
    && SHA256_PATTERN.test(response.previousCommitHash ?? "")
    && SHA256_PATTERN.test(response.commitHash ?? "")
    && typeof response.operationCommitted === "boolean";
}

function validateResponseOutcome(response, claims) {
  if (response.outcome === "applied") {
    return response.reason === null
      && response.operationCommitted === true
      && response.revision !== "0"
      && claims.receiptId !== null
      && claims.replayScopeId !== null
      && claims.sequence !== null
      && claims.nonceHash !== null;
  }
  return response.outcome === "rejected"
    && RESPONSE_REJECTION_REASONS.has(response.reason)
    && (
      response.operationCommitted === true
      || UNCOMMITTED_REASONS.has(response.reason)
    );
}

function validateResponseCommit(state, response) {
  const revision = BigInt(response.revision);
  if (response.operationCommitted) {
    if (commitHash(response) !== response.commitHash) return false;
  } else if (
    response.previousCommitHash !== response.commitHash
    || !UNCOMMITTED_REASONS.has(response.reason)
  ) {
    return false;
  } else {
    return revision !== state.highestRevision
      || response.commitHash === state.highestCommitHash;
  }
  if (revision === state.highestRevision) {
    return response.commitHash === state.highestCommitHash;
  }
  if (revision === state.highestRevision + 1n) {
    return response.previousCommitHash === state.highestCommitHash;
  }
  return true;
}

function verifySignedResponse(state, responseValue, request) {
  const response = responseSnapshot(responseValue);
  const requestDigest = requestHash(request);
  const claims = deriveReceiptClaims(request.receipt);
  if (
    !validateResponseCommon(
      state,
      response,
      request,
      requestDigest,
      claims,
    )
    || !validateResponseOutcome(response, claims)
    || !validateResponseCommit(state, response)
  ) {
    throw onlineReplayError("response_invalid");
  }
  const signature = typeof response.signature === "string"
    && response.signature.startsWith(SIGNATURE_PREFIX)
    ? decodeCanonicalBase64Url(
      response.signature.slice(SIGNATURE_PREFIX.length),
      64,
    )
    : null;
  if (signature === null) throw onlineReplayError("response_invalid");
  const unsignedResponse = {};
  for (const key of RESPONSE_UNSIGNED_KEYS) unsignedResponse[key] = response[key];
  let signatureValid = false;
  try {
    signatureValid = verifySignature(
      null,
      responseSigningBytes(unsignedResponse),
      state.responsePublicKey,
      signature,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) throw onlineReplayError("response_signature_invalid");

  const revision = BigInt(response.revision);
  if (revision > state.highestRevision) {
    state.highestRevision = revision;
    state.highestCommitHash = response.commitHash;
  }
  return Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_RESULT_SCHEMA,
    authorityId: response.authorityId,
    authorityGenerationId: response.authorityGenerationId,
    authorityClass: response.authorityClass,
    rollbackProtected: response.rollbackProtected,
    onlineRequired: response.onlineRequired,
    requestId: response.requestId,
    requestHash: response.requestHash,
    replayOperationId: response.replayOperationId,
    outcome: response.outcome,
    reason: response.reason,
    durable: response.durable,
    operationCommitted: response.operationCommitted,
    receiptId: response.receiptId,
    replayScopeId: response.replayScopeId,
    sequence: response.sequence,
    nonceHash: response.nonceHash,
    revision: response.revision,
    committedAtUnixNs: response.committedAtUnixNs,
    previousCommitHash: response.previousCommitHash,
    commitHash: response.commitHash,
    policyHash: response.policyHash,
    responseKeyId: response.responseKeyId,
    parentPid: response.parentPid,
    parentStartIdentity: response.parentStartIdentity,
    maxReceiptAgeNs: response.maxReceiptAgeNs,
    maxFutureSkewNs: response.maxFutureSkewNs,
    maxScopes: response.maxScopes,
    maxReceiptsPerScope: response.maxReceiptsPerScope,
    signature: response.signature,
    acceptedForGpuHmr: response.acceptedForGpuHmr,
    gpuHmrSuccess: response.gpuHmrSuccess,
    canSatisfyRuntimeProof: response.canSatisfyRuntimeProof,
  });
}

function verifyProbeResponse(state, responseValue, request) {
  const response = snapshotExactDataObject(
    responseValue,
    PROBE_RESPONSE_KEYS,
  );
  if (
    response === null
    || response.schemaVersion
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA
    || response.authorityId !== state.metadata.authorityId
    || response.authorityGenerationId
      !== state.metadata.authorityGenerationId
    || response.responseKeyId !== state.responseVerificationKey.keyId
    || response.parentPid !== state.metadata.parentPid
    || response.parentStartIdentity !== state.metadata.parentStartIdentity
    || response.probeId !== request.probeId
    || response.probeHash !== probeRequestHash(request)
    || response.authorityClass
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS
    || response.rollbackProtected !== true
    || response.onlineRequired !== true
    || response.durable !== false
    || response.acceptedForGpuHmr !== false
    || response.gpuHmrSuccess !== false
    || response.canSatisfyRuntimeProof !== false
    || response.maxReceiptAgeNs !== state.metadata.maxReceiptAgeNs
    || response.maxFutureSkewNs !== state.metadata.maxFutureSkewNs
    || response.maxScopes !== state.metadata.maxScopes
    || response.maxReceiptsPerScope
      !== state.metadata.maxReceiptsPerScope
    || response.policyHash !== state.metadata.policyHash
    || !canonicalU64String(response.revision)
    || !canonicalU64String(response.observedAtUnixNs)
    || !SHA256_PATTERN.test(response.commitHash ?? "")
  ) {
    throw onlineReplayError("probe_response_invalid");
  }
  const signature = typeof response.signature === "string"
    && response.signature.startsWith(SIGNATURE_PREFIX)
    ? decodeCanonicalBase64Url(
      response.signature.slice(SIGNATURE_PREFIX.length),
      64,
    )
    : null;
  if (signature === null) throw onlineReplayError("probe_response_invalid");
  const unsignedResponse = {};
  for (const key of PROBE_RESPONSE_UNSIGNED_KEYS) {
    unsignedResponse[key] = response[key];
  }
  let signatureValid = false;
  try {
    signatureValid = verifySignature(
      null,
      probeResponseSigningBytes(unsignedResponse),
      state.responsePublicKey,
      signature,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw onlineReplayError("probe_response_signature_invalid");
  }
  const revision = BigInt(response.revision);
  if (
    revision < state.highestRevision
    || (
      revision === state.highestRevision
      && response.commitHash !== state.highestCommitHash
    )
  ) {
    throw onlineReplayError("probe_response_rollback_detected");
  }
  if (revision > state.highestRevision) {
    state.highestRevision = revision;
    state.highestCommitHash = response.commitHash;
  }
  return Object.freeze({ ...response });
}

function exchangeWire(state, wire, signalValue, verifyResponseValue) {
  const inspectedSignal = signalState(signalValue);
  if (inspectedSignal.aborted) return Promise.reject(abortError());
  const requestFrame = frameFor(wire, MAX_REQUEST_FRAME_BYTES);
  if (requestFrame === null) {
    return Promise.reject(onlineReplayError("request_frame_invalid"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let receivedBytes = 0;
    let timer;
    const chunks = [];
    const socket = createConnection({ path: state.metadata.endpoint });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (inspectedSignal.signal !== null) {
        removeAbortListener(inspectedSignal.signal, onAbort);
      }
      socket.destroy();
      if (error === null) resolve(value);
      else reject(error);
    };
    const onAbort = () => finish(abortError());
    socket.on("connect", () => {
      connected = true;
      socket.write(requestFrame);
    });
    socket.on("data", (chunk) => {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > MAX_RESPONSE_FRAME_BYTES) {
        finish(onlineReplayError("response_frame_invalid"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.on("end", () => {
      if (settled) return;
      const parsed = parseFrame(
        Buffer.concat(chunks, receivedBytes),
        MAX_RESPONSE_FRAME_BYTES,
      );
      if (parsed === null) {
        finish(onlineReplayError("response_frame_invalid"));
        return;
      }
      try {
        finish(null, verifyResponseValue(parsed));
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => {
      finish(onlineReplayError(
        connected ? "authority_connection_failed" : "authority_unavailable",
        error,
        connected,
      ));
    });
    socket.on("close", () => {
      if (!settled) {
        finish(onlineReplayError(
          connected ? "authority_connection_closed" : "authority_unavailable",
          undefined,
          connected,
        ));
      }
    });
    timer = setTimeout(() => {
      finish(onlineReplayError("authority_timeout", undefined, true));
    }, state.metadata.operationTimeoutMs);
    if (inspectedSignal.signal !== null) {
      addAbortListener(inspectedSignal.signal, onAbort);
      if (nativeAbortSignalAborted(inspectedSignal.signal)) onAbort();
    }
  });
}

function exchange(state, request, signalValue) {
  const wire = Object.freeze({
    schemaVersion: WIRE_REQUEST_SCHEMA,
    authorityGenerationId: state.metadata.authorityGenerationId,
    request,
  });
  return exchangeWire(
    state,
    wire,
    signalValue,
    (response) => verifySignedResponse(state, response, request),
  );
}

function probe(state, signalValue) {
  const request = Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_REQUEST_SCHEMA,
    authorityId: state.metadata.authorityId,
    authorityGenerationId: state.metadata.authorityGenerationId,
    responseKeyId: state.responseVerificationKey.keyId,
    policyHash: state.metadata.policyHash,
    probeId: randomBytes(32).toString("base64url"),
  });
  return exchangeWire(
    state,
    request,
    signalValue,
    (response) => verifyProbeResponse(state, response, request),
  );
}

function clientPublicValue(authorityId) {
  return Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLIENT_SCHEMA,
    proofAuthority: CLIENT_PROOF_AUTHORITY,
    authorityId,
    authorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
    rollbackProtected: true,
    onlineRequired: true,
    durable: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

export function createGpuHmrMcpAdmissionOnlineReplayAuthorityClient(
  projectionValue,
) {
  const parsed = serverProjectionSnapshot(projectionValue);
  if (parsed === null) throw onlineReplayError("server_projection_invalid");
  const genesisMaterial = Object.freeze({
    authorityId: parsed.projection.authorityId,
    authorityGenerationId: parsed.projection.authorityGenerationId,
    responseKeyId: parsed.projection.responseVerificationKey.keyId,
    parentPid: parsed.projection.parentPid,
    parentStartIdentity: parsed.projection.parentStartIdentity,
    policyHash: parsed.projection.policyHash,
  });
  const encodedGenesis = canonicalJson(genesisMaterial);
  if (encodedGenesis === null) throw onlineReplayError("genesis_encoding_failed");
  const state = {
    metadata: parsed.projection,
    responseVerificationKey: parsed.projection.responseVerificationKey,
    responsePublicKey: parsed.responsePublicKey,
    highestRevision: 0n,
    highestCommitHash: domainSha256(GENESIS_HASH_DOMAIN, encodedGenesis),
  };
  const compareAndSet = async (requestValue, signal) => {
    const request = requestSnapshot(
      requestValue,
      state.metadata.authorityId,
    );
    if (request === null) throw onlineReplayError("request_invalid");
    return await exchange(state, request, signal);
  };
  const probeBound = async (signal) => await probe(state, signal);
  Object.freeze(compareAndSet);
  Object.freeze(probeBound);
  const projection = Object.freeze({
    authorityId: parsed.projection.authorityId,
    durable: false,
    authorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
    rollbackProtected: true,
    onlineRequired: true,
    operationTimeoutMs: parsed.projection.operationTimeoutMs,
    maxReceiptAgeNs: parsed.projection.maxReceiptAgeNs,
    maxFutureSkewNs: parsed.projection.maxFutureSkewNs,
    maxScopes: parsed.projection.maxScopes,
    maxReceiptsPerScope: parsed.projection.maxReceiptsPerScope,
    policyHash: parsed.projection.policyHash,
    probe: probeBound,
    compareAndSet,
  });
  const client = clientPublicValue(parsed.projection.authorityId);
  clientStates.set(client, Object.freeze({ projection }));
  return client;
}

export function gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(value) {
  return clientStates.get(value)?.projection ?? null;
}
