import { createHash, randomBytes } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_REQUEST_SCHEMA,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_RESULT_SCHEMA,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA,
  hashGpuHmrMcpAdmissionOnlineReplayExpectedBinding,
} from "./gpu-hmr-mcp-admission-online-replay-authority.mjs";
import {
  verifyGpuHmrMcpAdmissionReceipt,
} from "./gpu-hmr-mcp-admission-receipt-verifier.mjs";

export const GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_matrix_verification.v3";
export const GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_AUTHORITY =
  "matrix_external_trust_signature_binding_freshness_and_online_parent_replay_verification_support_only_not_gpu_hmr_acceptance";
export const GPU_HMR_MCP_ADMISSION_MATRIX_STAGED_VERIFICATION_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_matrix_staged_verification.v3";
export const GPU_HMR_MCP_ADMISSION_MATRIX_STAGED_VERIFICATION_AUTHORITY =
  "matrix_external_trust_signature_binding_and_freshness_staged_online_parent_replay_commit_pending_support_only_not_gpu_hmr_acceptance";
export const GPU_HMR_MCP_ADMISSION_REPLAY_REGISTRY_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_replay_registry.v3";
export const GPU_HMR_MCP_ADMISSION_REPLAY_AUTHORITY_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_replay_authority.v2";
export const GPU_HMR_MCP_ADMISSION_REPLAY_CAS_REQUEST_SCHEMA =
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_REQUEST_SCHEMA;
export const GPU_HMR_MCP_ADMISSION_REPLAY_CAS_RESULT_SCHEMA =
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_CAS_RESULT_SCHEMA;

const U64_MAX = 18_446_744_073_709_551_615n;
const MAX_PROCESS_ID = 0xffff_ffff;
const DEFAULT_MAX_REPLAY_SCOPES = 4_096;
const DEFAULT_MAX_RECEIPTS_PER_SCOPE = 65_536;
const IN_PROCESS_AUTHORITY_CLASS = "in_process_test_only";
const REPLAY_REGISTRY_OPTION_KEYS = Object.freeze([
  "maxScopes",
  "maxReceiptsPerScope",
  "authority",
  "authorityProbe",
]);
const VERIFICATION_CONTEXT_REQUIRED_KEYS = Object.freeze([
  "trustedVerificationKey",
  "validationRunChallenge",
  "receipt",
  "replayRegistry",
  "expectedBinding",
]);
const VERIFICATION_CONTEXT_OPTIONAL_KEYS = Object.freeze([
  "nowUnixNs",
  "maxAgeNs",
  "maxFutureSkewNs",
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
const ONLINE_PROBE_KEYS = Object.freeze([
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
  "signature",
]);
const ONLINE_RESULT_KEYS = Object.freeze([
  "schemaVersion",
  "authorityId",
  "authorityGenerationId",
  "authorityClass",
  "rollbackProtected",
  "onlineRequired",
  "requestId",
  "requestHash",
  "replayOperationId",
  "outcome",
  "reason",
  "durable",
  "operationCommitted",
  "receiptId",
  "replayScopeId",
  "sequence",
  "nonceHash",
  "revision",
  "committedAtUnixNs",
  "previousCommitHash",
  "commitHash",
  "policyHash",
  "responseKeyId",
  "parentPid",
  "parentStartIdentity",
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
  "signature",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
]);
const ONLINE_REJECTION_REASONS = new Set([
  "gpu_hmr_mcp_admission_verification_key_invalid",
  "gpu_hmr_mcp_admission_expected_challenge_invalid",
  "gpu_hmr_mcp_admission_receipt_shape_invalid",
  "gpu_hmr_mcp_admission_signer_key_mismatch",
  "gpu_hmr_mcp_admission_validation_run_challenge_mismatch",
  "gpu_hmr_mcp_admission_receipt_id_mismatch",
  "gpu_hmr_mcp_admission_signature_mismatch",
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
const ONLINE_FRESHNESS_CHECKED_REJECTION_REASONS = new Set([
  "gpu_hmr_mcp_admission_receipt_too_early_at_replay_commit",
  "gpu_hmr_mcp_admission_receipt_expired_before_replay_commit",
  "gpu_hmr_mcp_admission_receipt_replayed",
  "gpu_hmr_mcp_admission_sequence_not_increasing",
  "gpu_hmr_mcp_admission_nonce_replayed",
  "gpu_hmr_mcp_admission_replay_scope_capacity_exhausted",
  "gpu_hmr_mcp_admission_replay_scope_receipt_capacity_exhausted",
]);
const ONLINE_GENERATION_ID_PATTERN =
  /^gpu-hmr-mcp-online-replay-generation:sha256:[a-f0-9]{64}$/;
const ONLINE_RESPONSE_KEY_ID_PATTERN =
  /^gpu-hmr-mcp-online-replay-response-key:sha256:[a-f0-9]{64}$/;
const ONLINE_PARENT_START_ID_PATTERN =
  /^gpu-hmr-mcp-online-replay-parent-start:sha256:[a-f0-9]{64}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ONLINE_SIGNATURE_PATTERN = /^ed25519:[A-Za-z0-9_-]{86}$/;

const replayRegistryStates = new WeakMap();
const verifiedProjections = new WeakMap();
const stagedVerificationStates = new WeakMap();
const retiredStagedVerifications = new WeakSet();
const inProcessRequestClaims = new WeakMap();
const inProcessResults = new WeakSet();

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

function snapshotPlainDataObject(value) {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) {
      return null;
    }
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length === 0 || keys.some((key) => typeof key !== "string")) {
      return null;
    }
    return snapshotExactDataObject(value, keys);
  } catch {
    return null;
  }
}

function canonicalUnixNs(value, positive = false) {
  return typeof value === "bigint"
    && value >= (positive ? 1n : 0n)
    && value <= U64_MAX;
}

function canonicalU64String(value, positive = false) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return false;
  }
  try {
    const parsed = BigInt(value);
    return parsed <= U64_MAX && (!positive || parsed > 0n);
  } catch {
    return false;
  }
}

function canonicalBase64Url(value, byteLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === byteLength
      && decoded.toString("base64url") === value;
  } catch {
    return false;
  }
}

function positiveSafeInteger(value) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0;
}

function currentUnixNs() {
  return BigInt(Date.now()) * 1_000_000n;
}

function freshnessFailure(admittedAt, now, maxAgeNs, maxFutureSkewNs) {
  if (admittedAt > now && admittedAt - now > maxFutureSkewNs) {
    return "gpu_hmr_mcp_admission_receipt_from_future";
  }
  if (now > admittedAt && now - admittedAt > maxAgeNs) {
    return "gpu_hmr_mcp_admission_receipt_stale";
  }
  return null;
}

function sha256Id(prefix, value) {
  const digest = createHash("sha256")
    .update(prefix, "utf8")
    .update("\0", "utf8")
    .update(value)
    .digest("hex");
  return `${prefix}:sha256:${digest}`;
}

function randomReplayRegistryClaimantIdentity() {
  const entropy = randomBytes(32);
  try {
    return sha256Id("gpu-hmr-mcp-replay-registry-instance", entropy);
  } finally {
    entropy.fill(0);
  }
}

function registryEvidenceFields(state) {
  if (state === undefined) {
    return {
      replayAuthorityId: null,
      replayAuthorityClass: null,
      replayAuthorityDurable: false,
      replayOnlineRequired: false,
      replayOnlineVerified: false,
      replayRollbackProtected: false,
      replaySignedProbeVerified: false,
      replayAuthorityGenerationId: null,
      replayAuthorityProcessId: null,
      replayAuthorityParentStartIdentity: null,
      replayAuthorityPolicyHash: null,
      replayResponseKeyId: null,
      replayProbeRevision: null,
      replayProbeCommitHash: null,
      replayProbeObservedAtUnixNs: null,
    };
  }
  return {
    replayAuthorityId: state.authorityId,
    replayAuthorityClass: state.authorityClass,
    replayAuthorityDurable: false,
    replayOnlineRequired: state.onlineRequired,
    replayOnlineVerified: state.onlineVerified,
    replayRollbackProtected: state.rollbackProtected,
    replaySignedProbeVerified: state.signedProbeVerified,
    replayAuthorityGenerationId: state.authorityGenerationId,
    replayAuthorityProcessId: state.parentPid,
    replayAuthorityParentStartIdentity: state.parentStartIdentity,
    replayAuthorityPolicyHash: state.policyHash,
    replayResponseKeyId: state.responseKeyId,
    replayProbeRevision: state.probeRevision,
    replayProbeCommitHash: state.probeCommitHash,
    replayProbeObservedAtUnixNs: state.probeObservedAtUnixNs,
  };
}

function verificationResultBase(acceptedValue, reason, details = {}) {
  return {
    schemaVersion: GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_SCHEMA,
    accepted: acceptedValue,
    reason,
    proofAuthority: GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_AUTHORITY,
    signatureVerified: details.signatureVerified === true,
    challengeBound: details.challengeBound === true,
    bindingChecked: details.bindingChecked === true,
    freshnessChecked: details.freshnessChecked === true,
    commitFreshnessChecked: details.commitFreshnessChecked === true,
    replayChecked: details.replayChecked === true,
    replayCommitAttempted: details.replayCommitAttempted === true,
    replayCommitted: details.replayCommitted === true,
    replayCommitKnown: details.replayCommitKnown === true,
    replayCommitState: details.replayCommitState ?? "not_attempted",
    replayOperationCommitted: typeof details.replayOperationCommitted === "boolean"
      ? details.replayOperationCommitted
      : null,
    replayDurable: false,
    replayAuthorityId: details.replayAuthorityId ?? null,
    replayAuthorityDurable: false,
    replayAuthorityClass: details.replayAuthorityClass ?? null,
    replayOnlineRequired: details.replayOnlineRequired === true,
    replayOnlineVerified: details.replayOnlineVerified === true,
    replayRollbackProtected: details.replayRollbackProtected === true,
    replaySignedProbeVerified: details.replaySignedProbeVerified === true,
    replaySignedResponseVerified:
      details.replaySignedResponseVerified === true,
    replayAuthorityGenerationId:
      details.replayAuthorityGenerationId ?? null,
    replayAuthorityProcessId: details.replayAuthorityProcessId ?? null,
    replayAuthorityParentStartIdentity:
      details.replayAuthorityParentStartIdentity ?? null,
    replayAuthorityPolicyHash: details.replayAuthorityPolicyHash ?? null,
    replayResponseKeyId: details.replayResponseKeyId ?? null,
    replayRequestId: details.replayRequestId ?? null,
    replayRequestHash: details.replayRequestHash ?? null,
    replayOperationId: details.replayOperationId ?? null,
    replayRevision: details.replayRevision ?? null,
    replayCommittedAtUnixNs: details.replayCommittedAtUnixNs ?? null,
    replayPreviousCommitHash: details.replayPreviousCommitHash ?? null,
    replayCommitHash: details.replayCommitHash ?? null,
    replayResponseSignature: details.replayResponseSignature ?? null,
    replayAttemptCount: details.replayAttemptCount ?? 0,
    replayIndeterminateRetryUsed:
      details.replayIndeterminateRetryUsed === true,
    receiptId: details.receiptId ?? null,
    signerKeyId: details.signerKeyId ?? null,
    replayScopeId: details.replayScopeId ?? null,
    admittedAtUnixNs: details.admittedAtUnixNs ?? null,
    sequence: details.sequence ?? null,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  };
}

function refused(reason, details = {}) {
  return Object.freeze(verificationResultBase(false, reason, details));
}

function admissionProjection(verification, receipt) {
  return Object.freeze({
    required: true,
    receiptId: verification.receiptId,
    contractHash: receipt.computeExpectedOutputContractHash,
    semanticsHash: receipt.computeExpectedOutputSemanticsHash,
    compileTransportNonce: receipt.compileRequestNonce,
    artifactContentHash: receipt.artifactContentHash,
    fullRuntimeProofId: receipt.fullRuntimeProofId,
    proofLedgerId: receipt.proofLedgerId,
    runtimeSessionId: receipt.runnerRuntimeSessionId,
  });
}

function verifiedReceiptDetails(verification) {
  return {
    signatureVerified: true,
    challengeBound: true,
    receiptId: verification.receiptId,
    signerKeyId: verification.replayScope.signerKeyId,
    replayScopeId: verification.replayScope.replayScopeId,
    admittedAtUnixNs: verification.admittedAtUnixNs.toString(),
    sequence: verification.sequence.toString(),
  };
}

function deterministicReplayIdentities(state, receiptId, bindingHash) {
  const operationMaterial = JSON.stringify({
    authorityId: state.authorityId,
    registryClaimantIdentity: state.claimantIdentity,
    receiptId,
    expectedBindingHash: bindingHash,
  });
  const replayOperationId = sha256Id(
    "gpu-hmr-mcp-replay-operation",
    operationMaterial,
  );
  return Object.freeze({
    replayOperationId,
    requestId: sha256Id(
      "gpu-hmr-mcp-replay-cas-request",
      JSON.stringify({
        replayOperationId,
        authorityId: state.authorityId,
        registryClaimantIdentity: state.claimantIdentity,
        receiptId,
        expectedBindingHash: bindingHash,
      }),
    ),
  });
}

function staged(
  verification,
  receipt,
  replayRegistry,
  freshnessPolicy,
  expectedBindingHash,
  freshnessChecked,
) {
  const registryState = replayRegistryStates.get(replayRegistry);
  const identities = deterministicReplayIdentities(
    registryState,
    verification.receiptId,
    expectedBindingHash,
  );
  const evidence = registryEvidenceFields(registryState);
  const result = Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_MATRIX_STAGED_VERIFICATION_SCHEMA,
    staged: true,
    reason: null,
    proofAuthority:
      GPU_HMR_MCP_ADMISSION_MATRIX_STAGED_VERIFICATION_AUTHORITY,
    signatureVerified: true,
    challengeBound: true,
    bindingChecked: true,
    freshnessChecked,
    commitFreshnessChecked: false,
    replayChecked: false,
    replayCommitAttempted: false,
    replayCommitted: false,
    replayCommitKnown: false,
    replayCommitState: "pending",
    replayOperationCommitted: null,
    replayDurable: false,
    ...evidence,
    replaySignedResponseVerified: false,
    replayRequestId: identities.requestId,
    replayRequestHash: null,
    replayOperationId: identities.replayOperationId,
    replayRevision: null,
    replayCommittedAtUnixNs: null,
    replayPreviousCommitHash: null,
    replayCommitHash: null,
    replayResponseSignature: null,
    replayAttemptCount: 0,
    replayIndeterminateRetryUsed: false,
    receiptId: verification.receiptId,
    signerKeyId: verification.replayScope.signerKeyId,
    replayScopeId: verification.replayScope.replayScopeId,
    admittedAtUnixNs: verification.admittedAtUnixNs.toString(),
    sequence: verification.sequence.toString(),
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
  stagedVerificationStates.set(result, Object.freeze({
    verification,
    receipt,
    replayRegistry,
    replayOperationId: identities.replayOperationId,
    requestId: identities.requestId,
    freshnessPolicy,
    expectedBindingHash,
    freshnessChecked,
    projection: admissionProjection(verification, receipt),
  }));
  return result;
}

function matchingExpectedBinding(receipt, expectedBinding) {
  return EXPECTED_BINDING_KEYS.every(
    (key) => receipt[key] === expectedBinding[key],
  );
}

function snapshotOnlineProbe(value, projection) {
  const probe = snapshotExactDataObject(value, ONLINE_PROBE_KEYS);
  if (
    probe === null
    || probe.schemaVersion
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_PROBE_RESPONSE_SCHEMA
    || probe.authorityId !== projection.authorityId
    || !ONLINE_GENERATION_ID_PATTERN.test(probe.authorityGenerationId ?? "")
    || !ONLINE_RESPONSE_KEY_ID_PATTERN.test(probe.responseKeyId ?? "")
    || !Number.isSafeInteger(probe.parentPid)
    || probe.parentPid <= 0
    || probe.parentPid > MAX_PROCESS_ID
    || !ONLINE_PARENT_START_ID_PATTERN.test(probe.parentStartIdentity ?? "")
    || !canonicalBase64Url(probe.probeId, 32)
    || !SHA256_PATTERN.test(probe.probeHash ?? "")
    || probe.authorityClass
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS
    || probe.rollbackProtected !== true
    || probe.onlineRequired !== true
    || probe.durable !== false
    || probe.acceptedForGpuHmr !== false
    || probe.gpuHmrSuccess !== false
    || probe.canSatisfyRuntimeProof !== false
    || probe.maxReceiptAgeNs !== projection.maxReceiptAgeNs
    || probe.maxFutureSkewNs !== projection.maxFutureSkewNs
    || probe.maxScopes !== projection.maxScopes
    || probe.maxReceiptsPerScope !== projection.maxReceiptsPerScope
    || probe.policyHash !== projection.policyHash
    || !canonicalU64String(probe.revision)
    || !canonicalU64String(probe.observedAtUnixNs)
    || !SHA256_PATTERN.test(probe.commitHash ?? "")
    || !ONLINE_SIGNATURE_PATTERN.test(probe.signature ?? "")
  ) {
    return null;
  }
  return probe;
}

function createInProcessReplayState(maxScopes, maxReceiptsPerScope) {
  const authorityId = sha256Id(
    "gpu-hmr-mcp-replay-authority",
    randomBytes(32),
  );
  return {
    kind: "in_process_test",
    authorityId,
    authorityClass: IN_PROCESS_AUTHORITY_CLASS,
    durable: false,
    onlineRequired: false,
    onlineVerified: false,
    rollbackProtected: false,
    signedProbeVerified: false,
    authorityGenerationId: null,
    parentPid: null,
    parentStartIdentity: null,
    policyHash: null,
    responseKeyId: null,
    probeRevision: null,
    probeCommitHash: null,
    probeObservedAtUnixNs: null,
    maxReceiptAgeNs: null,
    maxFutureSkewNs: null,
    maxScopes,
    maxReceiptsPerScope,
    claimantIdentity: randomReplayRegistryClaimantIdentity(),
    scopes: new Map(),
    revision: 0n,
    commitHash: sha256Id("gpu-hmr-mcp-in-process-genesis", authorityId),
    operationStates: new Map(),
  };
}

function replayConstraintFailure(state, verification, receipt) {
  const replayScopeId = verification.replayScope.replayScopeId;
  const scope = state.scopes.get(replayScopeId);
  if (scope?.highestReceiptId === verification.receiptId) {
    return "gpu_hmr_mcp_admission_receipt_replayed";
  }
  if (scope !== undefined && verification.sequence <= scope.highestSequence) {
    return "gpu_hmr_mcp_admission_sequence_not_increasing";
  }
  const nonceHash = sha256Id("gpu-hmr-mcp-admission-nonce", receipt.nonce);
  if (scope?.nonceHashes.has(nonceHash)) {
    return "gpu_hmr_mcp_admission_nonce_replayed";
  }
  if (scope === undefined) {
    if (state.scopes.size >= state.maxScopes) {
      return "gpu_hmr_mcp_admission_replay_scope_capacity_exhausted";
    }
  } else if (scope.nonceHashes.size >= state.maxReceiptsPerScope) {
    return "gpu_hmr_mcp_admission_replay_scope_receipt_capacity_exhausted";
  }
  return null;
}

function applyInProcessReplay(state, verification, receipt) {
  const replayScopeId = verification.replayScope.replayScopeId;
  const nonceHash = sha256Id("gpu-hmr-mcp-admission-nonce", receipt.nonce);
  const scope = state.scopes.get(replayScopeId);
  if (scope === undefined) {
    state.scopes.set(replayScopeId, {
      highestSequence: verification.sequence,
      highestReceiptId: verification.receiptId,
      nonceHashes: new Set([nonceHash]),
    });
    return;
  }
  scope.highestSequence = verification.sequence;
  scope.highestReceiptId = verification.receiptId;
  scope.nonceHashes.add(nonceHash);
}

function inProcessCompareAndSet(state, request) {
  const claims = inProcessRequestClaims.get(request);
  if (claims === undefined) {
    throw new Error("gpu_hmr_mcp_admission_replay_request_untrusted");
  }
  const { verification, receipt } = claims;
  const reason = replayConstraintFailure(state, verification, receipt);
  if (reason === null) applyInProcessReplay(state, verification, receipt);
  state.revision += 1n;
  const previousCommitHash = state.commitHash;
  const committedAtUnixNs = currentUnixNs().toString();
  const requestHash = sha256Id(
    "gpu-hmr-mcp-in-process-request",
    JSON.stringify({
      authorityId: request.authorityId,
      replayOperationId: request.replayOperationId,
      expectedBindingHash: request.expectedBindingHash,
      requestId: request.requestId,
      receiptId: verification.receiptId,
    }),
  );
  state.commitHash = sha256Id(
    "gpu-hmr-mcp-in-process-commit",
    JSON.stringify({
      previousCommitHash,
      revision: state.revision.toString(),
      requestHash,
      reason,
    }),
  );
  const result = Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_REPLAY_CAS_RESULT_SCHEMA,
    authorityId: state.authorityId,
    authorityGenerationId: null,
    authorityClass: IN_PROCESS_AUTHORITY_CLASS,
    rollbackProtected: false,
    onlineRequired: false,
    requestId: request.requestId,
    requestHash,
    replayOperationId: request.replayOperationId,
    outcome: reason === null ? "applied" : "rejected",
    reason,
    durable: false,
    operationCommitted: true,
    receiptId: verification.receiptId,
    replayScopeId: verification.replayScope.replayScopeId,
    sequence: verification.sequence.toString(),
    nonceHash: sha256Id("gpu-hmr-mcp-admission-nonce", receipt.nonce),
    revision: state.revision.toString(),
    committedAtUnixNs,
    previousCommitHash,
    commitHash: state.commitHash,
    policyHash: null,
    responseKeyId: null,
    parentPid: null,
    parentStartIdentity: null,
    maxReceiptAgeNs: null,
    maxFutureSkewNs: null,
    maxScopes: state.maxScopes,
    maxReceiptsPerScope: state.maxReceiptsPerScope,
    signature: null,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
  inProcessResults.add(result);
  return result;
}

function registerReplayRegistry(state) {
  const registry = Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_REPLAY_REGISTRY_SCHEMA,
    proofAuthority: state.kind === "online_parent"
      ? "signed_online_parent_process_replay_binding_only_not_gpu_hmr_acceptance"
      : "in_process_test_replay_state_only_not_gpu_hmr_acceptance",
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    testOnly: state.kind !== "online_parent",
    maxScopes: state.maxScopes,
    maxReceiptsPerScope: state.maxReceiptsPerScope,
    replayAuthorityId: state.authorityId,
    replayAuthorityClass: state.authorityClass,
    replayAuthorityDurable: false,
    replayOnlineRequired: state.onlineRequired,
    replayOnlineVerified: state.onlineVerified,
    replayRollbackProtected: state.rollbackProtected,
    replaySignedProbeVerified: state.signedProbeVerified,
    replayAuthorityGenerationId: state.authorityGenerationId,
    replayAuthorityPolicyHash: state.policyHash,
  });
  replayRegistryStates.set(registry, state);
  return registry;
}

export function createGpuHmrMcpAdmissionReplayRegistry(optionsValue = {}) {
  const options = snapshotDataObject(
    optionsValue,
    [],
    REPLAY_REGISTRY_OPTION_KEYS,
  );
  if (options === null) {
    throw new Error("gpu_hmr_mcp_admission_replay_registry_options_invalid");
  }
  if (
    Object.prototype.hasOwnProperty.call(options, "authority")
    || Object.prototype.hasOwnProperty.call(options, "authorityProbe")
  ) {
    throw new Error("gpu_hmr_mcp_admission_replay_authority_invalid");
  }
  const maxScopes = options.maxScopes ?? DEFAULT_MAX_REPLAY_SCOPES;
  const maxReceiptsPerScope =
    options.maxReceiptsPerScope ?? DEFAULT_MAX_RECEIPTS_PER_SCOPE;
  if (!positiveSafeInteger(maxScopes) || !positiveSafeInteger(maxReceiptsPerScope)) {
    throw new Error("gpu_hmr_mcp_admission_replay_registry_capacity_invalid");
  }
  return registerReplayRegistry(
    createInProcessReplayState(maxScopes, maxReceiptsPerScope),
  );
}

export async function createGpuHmrMcpAdmissionOnlineReplayRegistry(
  authorityValue,
) {
  const projection =
    gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(authorityValue);
  if (
    projection === null
    || projection.authorityClass
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS
    || projection.durable !== false
    || projection.onlineRequired !== true
    || projection.rollbackProtected !== true
  ) {
    throw new Error("gpu_hmr_mcp_admission_replay_authority_invalid");
  }

  let probeValue;
  try {
    probeValue = await projection.probe();
  } catch (error) {
    throw new Error(
      "gpu_hmr_mcp_admission_online_replay_authority_probe_failed",
      { cause: error },
    );
  }
  const probe = snapshotOnlineProbe(probeValue, projection);
  if (probe === null) {
    throw new Error("gpu_hmr_mcp_admission_replay_authority_probe_invalid");
  }

  return registerReplayRegistry({
    kind: "online_parent",
    compareAndSet: projection.compareAndSet,
    authorityId: projection.authorityId,
    authorityClass: projection.authorityClass,
    durable: false,
    onlineRequired: true,
    onlineVerified: true,
    rollbackProtected: true,
    signedProbeVerified: true,
    authorityGenerationId: probe.authorityGenerationId,
    parentPid: probe.parentPid,
    parentStartIdentity: probe.parentStartIdentity,
    policyHash: projection.policyHash,
    responseKeyId: probe.responseKeyId,
    probeRevision: probe.revision,
    probeCommitHash: probe.commitHash,
    probeObservedAtUnixNs: probe.observedAtUnixNs,
    maxReceiptAgeNs: projection.maxReceiptAgeNs,
    maxFutureSkewNs: projection.maxFutureSkewNs,
    maxScopes: projection.maxScopes,
    maxReceiptsPerScope: projection.maxReceiptsPerScope,
    claimantIdentity: randomReplayRegistryClaimantIdentity(),
    operationStates: new Map(),
  });
}

export function gpuHmrMcpAdmissionReplayRegistryEvidence(value) {
  const state = replayRegistryStates.get(value);
  if (state === undefined) return null;
  return Object.freeze({
    authorityId: state.authorityId,
    authorityClass: state.authorityClass,
    durable: false,
    onlineRequired: state.onlineRequired,
    onlineVerified: state.onlineVerified,
    rollbackProtected: state.rollbackProtected,
    signedProbeVerified: state.signedProbeVerified,
    testOnly: state.kind !== "online_parent",
    authorityGenerationId: state.authorityGenerationId,
    parentPid: state.parentPid,
    parentStartIdentity: state.parentStartIdentity,
    policyHash: state.policyHash,
    responseKeyId: state.responseKeyId,
    probeRevision: state.probeRevision,
    probeCommitHash: state.probeCommitHash,
    probeObservedAtUnixNs: state.probeObservedAtUnixNs,
    maxReceiptAgeNs: state.maxReceiptAgeNs,
    maxFutureSkewNs: state.maxFutureSkewNs,
    maxScopes: state.maxScopes,
    maxReceiptsPerScope: state.maxReceiptsPerScope,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function replayCasRequest(
  state,
  receipt,
  replayOperationId,
  requestId,
  expectedBindingHash,
) {
  return Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_REPLAY_CAS_REQUEST_SCHEMA,
    authorityId: state.authorityId,
    replayOperationId,
    expectedBindingHash,
    requestId,
    receipt,
  });
}

function errorOutcomeIndeterminate(error) {
  try {
    if (error === null || typeof error !== "object" || isProxy(error)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, "outcome");
    return descriptor !== undefined
      && Object.prototype.hasOwnProperty.call(descriptor, "value")
      && descriptor.value === "indeterminate";
  } catch {
    return false;
  }
}

function normalizeOnlineResult(state, value, request, verification) {
  const result = snapshotExactDataObject(value, ONLINE_RESULT_KEYS);
  if (
    result === null
    || result.schemaVersion !== GPU_HMR_MCP_ADMISSION_REPLAY_CAS_RESULT_SCHEMA
    || result.authorityId !== state.authorityId
    || result.authorityGenerationId !== state.authorityGenerationId
    || result.authorityClass
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS
    || result.rollbackProtected !== true
    || result.onlineRequired !== true
    || result.durable !== false
    || result.requestId !== request.requestId
    || result.replayOperationId !== request.replayOperationId
    || result.receiptId !== verification.receiptId
    || result.replayScopeId !== verification.replayScope.replayScopeId
    || result.sequence !== verification.sequence.toString()
    || result.policyHash !== state.policyHash
    || result.responseKeyId !== state.responseKeyId
    || result.parentPid !== state.parentPid
    || result.parentStartIdentity !== state.parentStartIdentity
    || result.maxReceiptAgeNs !== state.maxReceiptAgeNs
    || result.maxFutureSkewNs !== state.maxFutureSkewNs
    || result.maxScopes !== state.maxScopes
    || result.maxReceiptsPerScope !== state.maxReceiptsPerScope
    || result.acceptedForGpuHmr !== false
    || result.gpuHmrSuccess !== false
    || result.canSatisfyRuntimeProof !== false
    || !canonicalU64String(result.revision)
    || !canonicalU64String(result.committedAtUnixNs)
    || !/^sha256:[a-f0-9]{64}$/.test(result.requestHash ?? "")
    || !/^sha256:[a-f0-9]{64}$/.test(result.previousCommitHash ?? "")
    || !/^sha256:[a-f0-9]{64}$/.test(result.commitHash ?? "")
    || !/^ed25519:[A-Za-z0-9_-]{86}$/.test(result.signature ?? "")
    || typeof result.operationCommitted !== "boolean"
  ) {
    return null;
  }
  if (
    !(
      result.outcome === "applied"
      && result.reason === null
      && result.operationCommitted === true
    )
    && !(
      result.outcome === "rejected"
      && ONLINE_REJECTION_REASONS.has(result.reason)
    )
  ) {
    return null;
  }
  return Object.freeze({ ...result, signedResponseVerified: true });
}

function normalizeInProcessResult(state, value, request, verification) {
  if (
    !inProcessResults.has(value)
    || value.authorityId !== state.authorityId
    || value.requestId !== request.requestId
    || value.replayOperationId !== request.replayOperationId
    || value.receiptId !== verification.receiptId
    || value.replayScopeId !== verification.replayScope.replayScopeId
    || value.sequence !== verification.sequence.toString()
  ) {
    return null;
  }
  return Object.freeze({ ...value, signedResponseVerified: false });
}

function replayCommitDetails(state, request, result, attemptCount, retryUsed) {
  return {
    ...registryEvidenceFields(state),
    replaySignedResponseVerified: result.signedResponseVerified === true,
    replayRequestId: result.requestId,
    replayRequestHash: result.requestHash,
    replayOperationId: request.replayOperationId,
    replayRevision: result.revision,
    replayCommittedAtUnixNs: result.committedAtUnixNs,
    replayPreviousCommitHash: result.previousCommitHash,
    replayCommitHash: result.commitHash,
    replayResponseSignature: result.signature,
    replayAttemptCount: attemptCount,
    replayIndeterminateRetryUsed: retryUsed,
    replayOperationCommitted: result.operationCommitted,
  };
}

async function consumeReplayState(
  registry,
  verification,
  receipt,
  replayOperationId,
  requestId,
  expectedBindingHash,
) {
  const state = replayRegistryStates.get(registry);
  if (state === undefined) {
    return Object.freeze({
      reason: "gpu_hmr_mcp_admission_replay_registry_invalid",
      attempted: false,
      checked: false,
      committed: false,
      commitKnown: false,
      commitState: "not_attempted",
      details: registryEvidenceFields(undefined),
    });
  }
  let operationState = state.operationStates.get(replayOperationId);
  if (operationState !== undefined && operationState.requestId !== requestId) {
    return Object.freeze({
      reason: "gpu_hmr_mcp_admission_replay_authority_failed",
      attempted: false,
      checked: false,
      committed: false,
      commitKnown: false,
      commitState: "failed",
      details: {
        ...registryEvidenceFields(state),
        replayOperationId,
        replayRequestId: requestId,
        replayAttemptCount: 0,
      },
    });
  }
  if (operationState?.status === "known") {
    const priorApplied = operationState.outcome === "applied";
    return Object.freeze({
      reason: priorApplied
        ? "gpu_hmr_mcp_admission_receipt_replayed"
        : operationState.reason,
      attempted: false,
      checked: true,
      committed: false,
      commitKnown: true,
      commitState: "rejected",
      freshnessChecked: priorApplied || operationState.freshnessChecked,
      details: {
        ...registryEvidenceFields(state),
        ...operationState.details,
        replayOperationId,
        replayRequestId: requestId,
        replayAttemptCount: 0,
        replayIndeterminateRetryUsed: false,
      },
    });
  }
  if (operationState?.status === "pending") {
    return Object.freeze({
      reason: "gpu_hmr_mcp_admission_replay_authority_indeterminate",
      attempted: false,
      checked: false,
      committed: false,
      commitKnown: false,
      commitState: "pending",
      details: {
        ...registryEvidenceFields(state),
        replayOperationId,
        replayRequestId: requestId,
        replayAttemptCount: 0,
      },
    });
  }
  if (operationState === undefined) {
    operationState = {
      requestId,
      status: "pending",
      outcome: null,
      reason: null,
      freshnessChecked: false,
      details: null,
    };
    state.operationStates.set(replayOperationId, operationState);
  } else {
    operationState.status = "pending";
  }

  const request = replayCasRequest(
    state,
    receipt,
    replayOperationId,
    requestId,
    expectedBindingHash,
  );
  if (state.kind === "in_process_test") {
    inProcessRequestClaims.set(request, { verification, receipt });
  }

  const maximumAttempts = state.kind === "online_parent" ? 2 : 1;
  let attemptCount = 0;
  let retryUsed = false;
  let lastIndeterminate = false;
  let authorityValue;
  while (attemptCount < maximumAttempts) {
    attemptCount += 1;
    try {
      authorityValue = state.kind === "online_parent"
        ? await state.compareAndSet(request)
        : inProcessCompareAndSet(state, request);
      lastIndeterminate = false;
      break;
    } catch (error) {
      lastIndeterminate = errorOutcomeIndeterminate(error);
      if (lastIndeterminate && attemptCount < maximumAttempts) {
        retryUsed = true;
        continue;
      }
      operationState.status = lastIndeterminate ? "indeterminate" : "failed";
      return Object.freeze({
        reason: lastIndeterminate
          ? "gpu_hmr_mcp_admission_replay_authority_indeterminate"
          : "gpu_hmr_mcp_admission_replay_authority_failed",
        attempted: true,
        checked: false,
        committed: false,
        commitKnown: false,
        commitState: lastIndeterminate ? "indeterminate" : "failed",
        details: {
          ...registryEvidenceFields(state),
          replayOperationId,
          replayRequestId: requestId,
          replayAttemptCount: attemptCount,
          replayIndeterminateRetryUsed: retryUsed,
        },
      });
    }
  }

  const result = state.kind === "online_parent"
    ? normalizeOnlineResult(state, authorityValue, request, verification)
    : normalizeInProcessResult(state, authorityValue, request, verification);
  if (result === null) {
    operationState.status = "failed";
    return Object.freeze({
      reason: "gpu_hmr_mcp_admission_replay_authority_result_invalid",
      attempted: true,
      checked: false,
      committed: false,
      commitKnown: false,
      commitState: "failed",
      details: {
        ...registryEvidenceFields(state),
        replayOperationId,
        replayRequestId: requestId,
        replayAttemptCount: attemptCount,
        replayIndeterminateRetryUsed: retryUsed,
      },
    });
  }

  const details = replayCommitDetails(
    state,
    request,
    result,
    attemptCount,
    retryUsed,
  );
  operationState.status = "known";
  operationState.outcome = result.outcome;
  operationState.reason = result.reason;
  operationState.freshnessChecked = state.kind === "in_process_test"
    || result.outcome === "applied"
    || ONLINE_FRESHNESS_CHECKED_REJECTION_REASONS.has(result.reason);
  operationState.details = Object.freeze({ ...details });
  if (result.outcome === "applied") {
    return Object.freeze({
      reason: null,
      attempted: true,
      checked: true,
      committed: true,
      commitKnown: true,
      commitState: "applied",
      freshnessChecked: true,
      details,
    });
  }
  return Object.freeze({
    reason: result.reason,
    attempted: true,
    checked: true,
    committed: false,
    commitKnown: true,
    commitState: "rejected",
    freshnessChecked: state.kind === "in_process_test"
      || ONLINE_FRESHNESS_CHECKED_REJECTION_REASONS.has(result.reason),
    details,
  });
}

export function stageGpuHmrMcpAdmissionReceiptForMatrix(contextValue) {
  const context = snapshotDataObject(
    contextValue,
    VERIFICATION_CONTEXT_REQUIRED_KEYS,
    VERIFICATION_CONTEXT_OPTIONAL_KEYS,
  );
  if (context === null) {
    return refused("gpu_hmr_mcp_admission_matrix_context_invalid");
  }
  const expectedBinding = snapshotExactDataObject(
    context.expectedBinding,
    EXPECTED_BINDING_KEYS,
  );
  const expectedBindingHash = expectedBinding === null
    ? null
    : hashGpuHmrMcpAdmissionOnlineReplayExpectedBinding(expectedBinding);
  if (expectedBinding === null || expectedBindingHash === null) {
    return refused("gpu_hmr_mcp_admission_expected_binding_invalid");
  }
  const registryState = replayRegistryStates.get(context.replayRegistry);
  if (registryState === undefined) {
    return refused("gpu_hmr_mcp_admission_replay_registry_invalid");
  }
  const hasNow = Object.prototype.hasOwnProperty.call(context, "nowUnixNs");
  const hasMaxAge = Object.prototype.hasOwnProperty.call(context, "maxAgeNs");
  const hasMaxFutureSkew = Object.prototype.hasOwnProperty.call(
    context,
    "maxFutureSkewNs",
  );
  if (
    (hasMaxAge && !canonicalUnixNs(context.maxAgeNs, true))
    || (hasMaxFutureSkew && !canonicalUnixNs(context.maxFutureSkewNs))
  ) {
    return refused("gpu_hmr_mcp_admission_freshness_policy_invalid");
  }
  if (registryState.kind === "online_parent") {
    if (
      (hasMaxAge
        && registryState.maxReceiptAgeNs !== context.maxAgeNs.toString())
      || (hasMaxFutureSkew
        && registryState.maxFutureSkewNs
          !== context.maxFutureSkewNs.toString())
    ) {
      return refused(
        "gpu_hmr_mcp_admission_replay_authority_policy_mismatch",
        registryEvidenceFields(registryState),
      );
    }
  } else if (
    !(hasNow && hasMaxAge && hasMaxFutureSkew)
    || !canonicalUnixNs(context.nowUnixNs)
  ) {
    return refused("gpu_hmr_mcp_admission_freshness_policy_invalid");
  }

  const verification = verifyGpuHmrMcpAdmissionReceipt(
    context.trustedVerificationKey,
    context.receipt,
    context.validationRunChallenge,
  );
  if (verification?.verified !== true) {
    return refused(
      verification?.reason
        ?? "gpu_hmr_mcp_admission_signature_verification_failed",
      registryEvidenceFields(registryState),
    );
  }
  const receipt = snapshotPlainDataObject(context.receipt);
  const verifiedDetails = {
    ...registryEvidenceFields(registryState),
    ...verifiedReceiptDetails(verification),
  };
  if (receipt === null || !matchingExpectedBinding(receipt, expectedBinding)) {
    return refused("gpu_hmr_mcp_admission_signed_binding_mismatch", {
      ...verifiedDetails,
      bindingChecked: true,
    });
  }
  const freshnessReason = registryState.kind === "in_process_test"
    ? freshnessFailure(
      verification.admittedAtUnixNs,
      context.nowUnixNs,
      context.maxAgeNs,
      context.maxFutureSkewNs,
    )
    : null;
  if (freshnessReason !== null) {
    return refused(freshnessReason, {
      ...verifiedDetails,
      bindingChecked: true,
      freshnessChecked: true,
    });
  }

  return staged(
    verification,
    receipt,
    context.replayRegistry,
    Object.freeze({
      maxAgeNs: context.maxAgeNs,
      maxFutureSkewNs: context.maxFutureSkewNs,
    }),
    expectedBindingHash,
    registryState.kind === "in_process_test",
  );
}

export function discardGpuHmrMcpAdmissionReceiptForMatrix(stagedValue) {
  if (stagedValue === null || typeof stagedValue !== "object") return false;
  if (retiredStagedVerifications.has(stagedValue)) return false;
  if (!stagedVerificationStates.delete(stagedValue)) return false;
  retiredStagedVerifications.add(stagedValue);
  return true;
}

export async function commitGpuHmrMcpAdmissionReceiptForMatrix(stagedValue) {
  if (stagedValue === null || typeof stagedValue !== "object") {
    return refused(
      "gpu_hmr_mcp_admission_matrix_staged_verification_invalid",
    );
  }
  if (retiredStagedVerifications.has(stagedValue)) {
    return refused(
      "gpu_hmr_mcp_admission_matrix_staged_verification_already_used",
    );
  }
  const state = stagedVerificationStates.get(stagedValue);
  if (state === undefined) {
    return refused(
      "gpu_hmr_mcp_admission_matrix_staged_verification_invalid",
    );
  }
  stagedVerificationStates.delete(stagedValue);
  retiredStagedVerifications.add(stagedValue);

  const {
    verification,
    receipt,
    replayRegistry,
    replayOperationId,
    requestId,
    freshnessPolicy,
    expectedBindingHash,
    freshnessChecked,
  } = state;
  const registryState = replayRegistryStates.get(replayRegistry);
  const details = {
    ...registryEvidenceFields(registryState),
    ...verifiedReceiptDetails(verification),
    bindingChecked: true,
    freshnessChecked,
    replayOperationId,
    replayRequestId: requestId,
  };

  if (registryState?.kind === "in_process_test") {
    const commitFreshnessReason = freshnessFailure(
      verification.admittedAtUnixNs,
      currentUnixNs(),
      freshnessPolicy.maxAgeNs,
      freshnessPolicy.maxFutureSkewNs,
    );
    if (commitFreshnessReason !== null) {
      return refused(commitFreshnessReason, {
        ...details,
        commitFreshnessChecked: true,
      });
    }
  }

  const replayCommit = await consumeReplayState(
    replayRegistry,
    verification,
    receipt,
    replayOperationId,
    requestId,
    expectedBindingHash,
  );
  const committedDetails = {
    ...details,
    ...replayCommit.details,
    freshnessChecked:
      freshnessChecked || replayCommit.freshnessChecked === true,
    commitFreshnessChecked: replayCommit.freshnessChecked === true,
    replayChecked: replayCommit.checked,
    replayCommitAttempted: replayCommit.attempted,
    replayCommitted: replayCommit.committed,
    replayCommitKnown: replayCommit.commitKnown,
    replayCommitState: replayCommit.commitState,
  };
  if (replayCommit.reason !== null) {
    return refused(replayCommit.reason, committedDetails);
  }

  const result = Object.freeze(verificationResultBase(
    true,
    null,
    committedDetails,
  ));
  verifiedProjections.set(result, admissionProjection(verification, receipt));
  return result;
}

export async function verifyGpuHmrMcpAdmissionReceiptForMatrix(contextValue) {
  const stagedVerification = stageGpuHmrMcpAdmissionReceiptForMatrix(
    contextValue,
  );
  if (!stagedVerificationStates.has(stagedVerification)) {
    return stagedVerification;
  }
  return await commitGpuHmrMcpAdmissionReceiptForMatrix(stagedVerification);
}

export function verifiedGpuHmrMcpAdmissionReceiptProjection(value) {
  return verifiedProjections.get(value) ?? null;
}

export function stagedGpuHmrMcpAdmissionReceiptProjection(value) {
  return stagedVerificationStates.get(value)?.projection ?? null;
}
