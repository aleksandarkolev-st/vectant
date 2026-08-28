import { isProxy } from 'node:util/types';
import {
  createGpuHmrMcpAdmissionOnlineReplayAuthorityClient,
  gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection,
  GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
} from './gpu-hmr-mcp-admission-online-replay-authority.mjs';
import {
  createGpuHmrMcpAdmissionOnlineReplayRegistry,
  gpuHmrMcpAdmissionReplayRegistryEvidence,
} from './gpu-hmr-mcp-admission-receipt-matrix-verifier.mjs';
import {
  hashGpuHmrMcpValidationRunChallenge,
  parseGpuHmrMcpAdmissionVerificationKey,
} from './gpu-hmr-mcp-admission-receipt-verifier.mjs';

export const GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_SCHEMA =
  'synthi.gpu_hmr.mcp_admission_trust_material.v3';
export const GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_AUTHORITY =
  'live_mcp_control_channel_trust_material_only_not_gpu_hmr_acceptance';

const U64_MAX = 18_446_744_073_709_551_615n;
const UNSAFE_PATH_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const TRUST_MATERIAL_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'verificationKey',
  'validationRunChallenge',
  'replayPolicyRequired',
  'freshnessPolicyRequired',
  'onlineReplayAuthority',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
]);
const ONLINE_AUTHORITY_KEYS = Object.freeze([
  'authorityId',
  'authorityGenerationId',
  'responseVerificationKey',
  'endpoint',
  'parentPid',
  'parentStartIdentity',
  'transport',
  'operationTimeoutMs',
  'maxReceiptAgeNs',
  'maxFutureSkewNs',
  'maxScopes',
  'maxReceiptsPerScope',
  'policyHash',
]);
const RESPONSE_KEY_KEYS = Object.freeze([
  'schemaVersion',
  'algorithm',
  'keyId',
  'publicKey',
]);
const TRUST_POLICY_KEYS = Object.freeze([
  'maxAgeNs',
  'maxFutureSkewNs',
]);
function snapshotDataObject(value, requiredKeys, optionalKeys = []) {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value)) {
      return null;
    }
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    const required = new Set(requiredKeys);
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (
      ownKeys.some((key) => typeof key !== 'string' || !allowed.has(key))
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
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || Object.prototype.hasOwnProperty.call(descriptor, 'get')
        || Object.prototype.hasOwnProperty.call(descriptor, 'set')
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

function canonicalUnixNs(value, positive = false) {
  return typeof value === 'bigint'
    && value >= (positive ? 1n : 0n)
    && value <= U64_MAX;
}

function extractTrustMaterial(value) {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value)) {
      return null;
    }
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      'gpu_parent_runtime_proof_admission_trust',
    );
    if (descriptor === undefined) return value;
    if (
      descriptor.enumerable !== true
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || Object.prototype.hasOwnProperty.call(descriptor, 'get')
      || Object.prototype.hasOwnProperty.call(descriptor, 'set')
    ) {
      return null;
    }
    return descriptor.value;
  } catch {
    return null;
  }
}

function parseTrustMaterialInternal(value) {
  const snapshot = snapshotExactDataObject(
    extractTrustMaterial(value),
    TRUST_MATERIAL_KEYS,
  );
  if (
    snapshot === null
    || snapshot.schemaVersion !== GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_SCHEMA
    || snapshot.proofAuthority !== GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_AUTHORITY
    || snapshot.replayPolicyRequired !== true
    || snapshot.freshnessPolicyRequired !== true
    || snapshot.acceptedForGpuHmr !== false
    || snapshot.gpuHmrSuccess !== false
    || snapshot.canSatisfyRuntimeProof !== false
    || hashGpuHmrMcpValidationRunChallenge(snapshot.validationRunChallenge) === null
  ) {
    return null;
  }
  const verificationKey = parseGpuHmrMcpAdmissionVerificationKey(
    snapshot.verificationKey,
  );
  const onlineSnapshot = snapshotExactDataObject(
    snapshot.onlineReplayAuthority,
    ONLINE_AUTHORITY_KEYS,
  );
  const responseVerificationKey = onlineSnapshot === null
    ? null
    : snapshotExactDataObject(
      onlineSnapshot.responseVerificationKey,
      RESPONSE_KEY_KEYS,
    );
  if (
    verificationKey === null
    || onlineSnapshot === null
    || responseVerificationKey === null
  ) {
    return null;
  }
  const onlineReplayAuthority = Object.freeze({
    ...onlineSnapshot,
    responseVerificationKey: Object.freeze({ ...responseVerificationKey }),
  });
  let onlineClient;
  let onlineProjection;
  try {
    onlineClient = createGpuHmrMcpAdmissionOnlineReplayAuthorityClient(
      onlineReplayAuthority,
    );
    onlineProjection =
      gpuHmrMcpAdmissionOnlineReplayAuthorityClientProjection(onlineClient);
  } catch {
    return null;
  }
  if (
    onlineProjection === null
    || onlineProjection.authorityClass
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS
    || onlineProjection.onlineRequired !== true
    || onlineProjection.rollbackProtected !== true
    || onlineProjection.durable !== false
  ) {
    return null;
  }
  const material = Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    proofAuthority: snapshot.proofAuthority,
    verificationKey,
    validationRunChallenge: snapshot.validationRunChallenge,
    replayPolicyRequired: true,
    freshnessPolicyRequired: true,
    onlineReplayAuthority,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
  return Object.freeze({
    material,
    onlineClient,
    onlineProjection,
  });
}

function parsePolicy(value) {
  if (value === undefined) return Object.freeze({});
  const policy = snapshotDataObject(value, [], TRUST_POLICY_KEYS);
  if (policy === null) return null;
  if (
    Object.prototype.hasOwnProperty.call(policy, 'maxAgeNs')
    && !canonicalUnixNs(policy.maxAgeNs, true)
  ) {
    return null;
  }
  if (
    Object.prototype.hasOwnProperty.call(policy, 'maxFutureSkewNs')
    && !canonicalUnixNs(policy.maxFutureSkewNs)
  ) {
    return null;
  }
  return policy;
}

export function parseGpuHmrMcpAdmissionTrustMaterial(value) {
  return parseTrustMaterialInternal(value)?.material ?? null;
}

export async function createGpuHmrMcpAdmissionMatrixTrust(
  materialValue,
  policyValue,
) {
  const parsed = parseTrustMaterialInternal(materialValue);
  if (parsed === null) {
    throw new Error('gpu_hmr_mcp_admission_trust_material_invalid');
  }
  const policy = parsePolicy(policyValue);
  if (policy === null) {
    throw new Error('gpu_hmr_mcp_admission_trust_policy_invalid');
  }
  const projection = parsed.onlineProjection;
  if (
    (Object.prototype.hasOwnProperty.call(policy, 'maxAgeNs')
      && policy.maxAgeNs.toString() !== projection.maxReceiptAgeNs)
    || (Object.prototype.hasOwnProperty.call(policy, 'maxFutureSkewNs')
      && policy.maxFutureSkewNs.toString() !== projection.maxFutureSkewNs)
  ) {
    throw new Error('gpu_hmr_mcp_admission_trust_policy_mismatch');
  }

  const replayRegistry = await createGpuHmrMcpAdmissionOnlineReplayRegistry(
    parsed.onlineClient,
  );
  const registryEvidence = gpuHmrMcpAdmissionReplayRegistryEvidence(
    replayRegistry,
  );
  const authority = parsed.material.onlineReplayAuthority;
  if (
    registryEvidence === null
    || registryEvidence.authorityId !== projection.authorityId
    || registryEvidence.authorityClass
      !== GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS
    || registryEvidence.onlineRequired !== true
    || registryEvidence.onlineVerified !== true
    || registryEvidence.rollbackProtected !== true
    || registryEvidence.signedProbeVerified !== true
    || registryEvidence.durable !== false
    || registryEvidence.authorityGenerationId
      !== authority.authorityGenerationId
    || registryEvidence.parentPid !== authority.parentPid
    || registryEvidence.parentStartIdentity !== authority.parentStartIdentity
    || registryEvidence.policyHash !== authority.policyHash
    || registryEvidence.responseKeyId
      !== authority.responseVerificationKey.keyId
    || registryEvidence.maxReceiptAgeNs !== authority.maxReceiptAgeNs
    || registryEvidence.maxFutureSkewNs !== authority.maxFutureSkewNs
    || registryEvidence.maxScopes !== authority.maxScopes
    || registryEvidence.maxReceiptsPerScope !== authority.maxReceiptsPerScope
  ) {
    throw new Error('gpu_hmr_mcp_admission_replay_authority_invalid');
  }

  return Object.freeze({
    verificationKey: parsed.material.verificationKey,
    validationRunChallenge: parsed.material.validationRunChallenge,
    replayRegistry,
    maxAgeNs: BigInt(projection.maxReceiptAgeNs),
    maxFutureSkewNs: BigInt(projection.maxFutureSkewNs),
    replayAuthorityId: projection.authorityId,
    replayAuthorityClass: GPU_HMR_MCP_ADMISSION_ONLINE_REPLAY_AUTHORITY_CLASS,
    replayAuthorityDurable: false,
    replayOnlineRequired: true,
    replayOnlineVerified: true,
    replayRollbackProtected: true,
    replaySignedProbeVerified: true,
    replayAuthorityGenerationId: registryEvidence.authorityGenerationId,
    replayAuthorityProcessId: registryEvidence.parentPid,
    replayAuthorityParentStartIdentity: registryEvidence.parentStartIdentity,
    replayAuthorityPolicyHash: registryEvidence.policyHash,
    replayResponseKeyId: registryEvidence.responseKeyId,
    replayProbeRevision: registryEvidence.probeRevision,
    replayProbeCommitHash: registryEvidence.probeCommitHash,
    replayProbeObservedAtUnixNs: registryEvidence.probeObservedAtUnixNs,
    requireReceiptForCompute: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

export async function loadGpuHmrMcpAdmissionMatrixTrust(filePath) {
  if (
    typeof filePath !== 'string'
    || filePath.length === 0
    || UNSAFE_PATH_CHARACTER_PATTERN.test(filePath)
  ) {
    throw new Error('gpu_hmr_mcp_admission_trust_path_invalid');
  }
  throw new Error('gpu_hmr_mcp_admission_trust_file_not_live_authority');
}
