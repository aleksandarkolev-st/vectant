import fs from 'node:fs/promises';
import { isProxy } from 'node:util/types';
import {
  createGpuHmrMcpAdmissionReplayRegistry,
} from './gpu-hmr-mcp-admission-receipt-matrix-verifier.mjs';
import {
  hashGpuHmrMcpValidationRunChallenge,
  parseGpuHmrMcpAdmissionVerificationKey,
} from './gpu-hmr-mcp-admission-receipt-verifier.mjs';

export const GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_SCHEMA =
  'synthi.gpu_hmr.mcp_admission_trust_material.v1';
export const GPU_HMR_MCP_ADMISSION_TRUST_MATERIAL_AUTHORITY =
  'live_mcp_control_channel_trust_material_only_not_gpu_hmr_acceptance';

const U64_MAX = 18_446_744_073_709_551_615n;
const TRUST_MATERIAL_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'verificationKey',
  'validationRunChallenge',
  'replayPolicyRequired',
  'freshnessPolicyRequired',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
]);
const TRUST_POLICY_KEYS = Object.freeze([
  'nowUnixNs',
  'maxAgeNs',
  'maxFutureSkewNs',
]);

function snapshotExactDataObject(value, requiredKeys) {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    const required = new Set(requiredKeys);
    if (
      ownKeys.length !== requiredKeys.length
      || ownKeys.some((key) => typeof key !== 'string' || !required.has(key))
    ) {
      return null;
    }
    const snapshot = {};
    for (const key of requiredKeys) {
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

function canonicalUnixNs(value, positive = false) {
  return typeof value === 'bigint'
    && value >= (positive ? 1n : 0n)
    && value <= U64_MAX;
}

function extractTrustMaterial(value) {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
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
}

export function parseGpuHmrMcpAdmissionTrustMaterial(value) {
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
  if (verificationKey === null) return null;
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    proofAuthority: snapshot.proofAuthority,
    verificationKey,
    validationRunChallenge: snapshot.validationRunChallenge,
    replayPolicyRequired: true,
    freshnessPolicyRequired: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

export function createGpuHmrMcpAdmissionMatrixTrust(materialValue, policyValue) {
  const material = parseGpuHmrMcpAdmissionTrustMaterial(materialValue);
  const policy = snapshotExactDataObject(policyValue, TRUST_POLICY_KEYS);
  if (material === null) {
    throw new Error('gpu_hmr_mcp_admission_trust_material_invalid');
  }
  if (
    policy === null
    || !canonicalUnixNs(policy.nowUnixNs)
    || !canonicalUnixNs(policy.maxAgeNs, true)
    || !canonicalUnixNs(policy.maxFutureSkewNs)
  ) {
    throw new Error('gpu_hmr_mcp_admission_trust_policy_invalid');
  }
  return Object.freeze({
    verificationKey: material.verificationKey,
    validationRunChallenge: material.validationRunChallenge,
    replayRegistry: createGpuHmrMcpAdmissionReplayRegistry(),
    nowUnixNs: policy.nowUnixNs,
    maxAgeNs: policy.maxAgeNs,
    maxFutureSkewNs: policy.maxFutureSkewNs,
    requireReceiptForCompute: true,
  });
}

export async function loadGpuHmrMcpAdmissionMatrixTrust(filePath, policy) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('gpu_hmr_mcp_admission_trust_path_invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    throw new Error('gpu_hmr_mcp_admission_trust_file_invalid');
  }
  return createGpuHmrMcpAdmissionMatrixTrust(parsed, policy);
}
