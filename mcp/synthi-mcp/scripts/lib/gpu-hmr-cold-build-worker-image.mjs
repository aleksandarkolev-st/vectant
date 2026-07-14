import { createHash } from 'node:crypto';

import { runColdBuildHostProcess } from './gpu-hmr-cold-build-container-contract.mjs';

export const COLD_BUILD_WORKER_IMAGE_EVIDENCE_SCHEMA =
  'synthi.gpu_hmr.cold_build_worker_image_evidence.v1';
export const COLD_BUILD_WORKER_IMAGE_EVIDENCE_AUTHORITY =
  'immutable_local_image_inspection_only_not_gpu_hmr_success';
export const COLD_BUILD_WORKER_IMAGE_RECEIPT_SCHEMA =
  'synthi.gpu_hmr.cold_build_worker_image_receipt.v1';
export const COLD_BUILD_WORKER_IMAGE_RECEIPT_AUTHORITY =
  'serialized_worker_image_commitments_only_not_plaintext_environment_or_gpu_hmr_success';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DIGEST_REFERENCE_PATTERN = /^[^\s@\0\r\n]+@sha256:[a-f0-9]{64}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PINNED_RESULTS = new WeakMap();
const WORKER_IMAGE_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'requestedImageReferenceHash',
  'requestedImageReferenceKind',
  'imageId',
  'operatingSystem',
  'architecture',
  'descriptorHash',
  'environmentHash',
  'environmentEntryCount',
  'repoDigestSetHash',
  'repoDigestCount',
  'inspectionEvidenceHash',
  'environmentValuesEmbedded',
  'repoDigestValuesEmbedded',
  'acceptedAsWorkerImageReceipt',
  'acceptedAsWorkerImageEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function recomputeEvidenceHash(evidence) {
  const projection = { ...evidence };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function normalizeImageReference(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) {
    throw new Error('cold_build_worker_image_reference_invalid');
  }
  if (SHA256_PATTERN.test(value)) {
    return { value, kind: 'image_id' };
  }
  if (DIGEST_REFERENCE_PATTERN.test(value)) {
    return { value, kind: 'repo_digest' };
  }
  throw new Error('cold_build_worker_image_reference_not_immutable');
}

function normalizeEnvironment(value) {
  if (value !== null && value !== undefined && !Array.isArray(value)) {
    throw new Error('cold_build_worker_image_environment_invalid');
  }
  const byName = new Map();
  for (const entry of value ?? []) {
    if (
      typeof entry !== 'string'
      || Buffer.byteLength(entry, 'utf8') > 64 * 1024
      || /[\0\r\n]/.test(entry)
    ) {
      throw new Error('cold_build_worker_image_environment_invalid');
    }
    const separator = entry.indexOf('=');
    const name = separator > 0 ? entry.slice(0, separator) : '';
    if (!ENVIRONMENT_NAME_PATTERN.test(name) || byName.has(name)) {
      throw new Error('cold_build_worker_image_environment_invalid');
    }
    byName.set(name, entry);
  }
  if (byName.size > 256) {
    throw new Error('cold_build_worker_image_environment_invalid');
  }
  return [...byName.values()].sort();
}

function normalizeRepoDigests(value) {
  if (value !== null && value !== undefined && !Array.isArray(value)) {
    throw new Error('cold_build_worker_image_repo_digests_invalid');
  }
  const digests = (value ?? []).map((entry) => {
    if (typeof entry !== 'string' || !DIGEST_REFERENCE_PATTERN.test(entry)) {
      throw new Error('cold_build_worker_image_repo_digests_invalid');
    }
    return entry;
  }).sort();
  if (new Set(digests).size !== digests.length || digests.length > 256) {
    throw new Error('cold_build_worker_image_repo_digests_invalid');
  }
  return digests;
}

function descriptorProjection(descriptor) {
  return {
    imageId: descriptor.imageId,
    operatingSystem: descriptor.operatingSystem,
    architecture: descriptor.architecture,
    environment: descriptor.environment,
    repoDigests: descriptor.repoDigests,
  };
}

function buildProjection(rawDescriptor, reference) {
  const imageId = rawDescriptor?.Id;
  const operatingSystem = rawDescriptor?.Os;
  const architecture = rawDescriptor?.Architecture;
  if (
    !SHA256_PATTERN.test(imageId ?? '')
    || operatingSystem !== 'linux'
    || !['amd64', 'arm64'].includes(architecture)
  ) {
    throw new Error('cold_build_worker_image_descriptor_invalid');
  }
  const environment = normalizeEnvironment(rawDescriptor?.Config?.Env);
  const repoDigests = normalizeRepoDigests(rawDescriptor?.RepoDigests);
  const referenceMatches = reference.kind === 'image_id'
    ? reference.value === imageId
    : repoDigests.includes(reference.value);
  if (!referenceMatches) {
    throw new Error('cold_build_worker_image_reference_mismatch');
  }
  return {
    imageId,
    operatingSystem,
    architecture,
    environment,
    repoDigests,
  };
}

function verifyProjection(result, reference) {
  const descriptor = result?.descriptor;
  const evidence = result?.evidence;
  const normalized = {
    imageId: descriptor?.imageId,
    operatingSystem: descriptor?.operatingSystem,
    architecture: descriptor?.architecture,
    environment: normalizeEnvironment(descriptor?.environment),
    repoDigests: normalizeRepoDigests(descriptor?.repoDigests),
  };
  if (
    !SHA256_PATTERN.test(normalized.imageId ?? '')
    || normalized.operatingSystem !== 'linux'
    || !['amd64', 'arm64'].includes(normalized.architecture)
    || (reference.kind === 'image_id'
      ? reference.value !== normalized.imageId
      : !normalized.repoDigests.includes(reference.value))
  ) {
    throw new Error('cold_build_worker_image_evidence_invalid');
  }
  const descriptorHash = contentHash(stableJson(descriptorProjection(normalized)));
  const environmentHash = contentHash(stableJson(normalized.environment));
  const repoDigestSetHash = contentHash(stableJson(normalized.repoDigests));
  if (
    evidence?.schemaVersion !== COLD_BUILD_WORKER_IMAGE_EVIDENCE_SCHEMA
    || evidence?.proofAuthority !== COLD_BUILD_WORKER_IMAGE_EVIDENCE_AUTHORITY
    || evidence?.requestedImageReferenceHash !== contentHash(reference.value)
    || evidence?.requestedImageReferenceKind !== reference.kind
    || evidence?.imageId !== normalized.imageId
    || evidence?.operatingSystem !== normalized.operatingSystem
    || evidence?.architecture !== normalized.architecture
    || evidence?.descriptorHash !== descriptorHash
    || evidence?.environmentHash !== environmentHash
    || evidence?.repoDigestSetHash !== repoDigestSetHash
    || evidence?.acceptedAsWorkerImageEvidence !== true
    || evidence?.acceptedForGpuHmr !== false
    || evidence?.gpuHmrSuccess !== false
    || evidence?.canSatisfyRuntimeProof !== false
    || evidence?.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(evidence) !== evidence?.evidenceHash
  ) {
    throw new Error('cold_build_worker_image_evidence_invalid');
  }
  return normalized;
}

export async function inspectImmutableColdBuildWorkerImage(imageReference, {
  dockerExecutable = 'docker',
  timeoutMs = 30_000,
} = {}) {
  const reference = normalizeImageReference(imageReference);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error('cold_build_worker_image_timeout_invalid');
  }
  const inspection = await runColdBuildHostProcess(
    dockerExecutable,
    ['image', 'inspect', reference.value],
    {
      timeoutMs,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
      encoding: 'utf8',
    },
  );
  if (inspection.exitCode !== 0 || inspection.timedOut === true) {
    throw new Error('cold_build_worker_image_inspection_failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(inspection.stdout);
  } catch {
    throw new Error('cold_build_worker_image_inspection_json_invalid');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('cold_build_worker_image_inspection_cardinality_invalid');
  }
  const descriptor = buildProjection(parsed[0], reference);
  const evidence = {
    schemaVersion: COLD_BUILD_WORKER_IMAGE_EVIDENCE_SCHEMA,
    proofAuthority: COLD_BUILD_WORKER_IMAGE_EVIDENCE_AUTHORITY,
    requestedImageReferenceHash: contentHash(reference.value),
    requestedImageReferenceKind: reference.kind,
    imageId: descriptor.imageId,
    operatingSystem: descriptor.operatingSystem,
    architecture: descriptor.architecture,
    descriptorHash: contentHash(stableJson(descriptorProjection(descriptor))),
    environmentHash: contentHash(stableJson(descriptor.environment)),
    repoDigestSetHash: contentHash(stableJson(descriptor.repoDigests)),
    acceptedAsWorkerImageEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = recomputeEvidenceHash(evidence);
  const result = { descriptor, evidence };
  PINNED_RESULTS.set(result, Object.freeze({
    reference: reference.value,
    kind: reference.kind,
    evidenceHash: evidence.evidenceHash,
  }));
  return result;
}

export function verifyImmutableColdBuildWorkerImage(result, imageReference) {
  const reference = normalizeImageReference(imageReference);
  const pinned = PINNED_RESULTS.get(result);
  let normalized;
  try {
    normalized = verifyProjection(result, reference);
  } catch {
    throw new Error('cold_build_worker_image_evidence_invalid');
  }
  if (
    !pinned
    || pinned.reference !== reference.value
    || pinned.kind !== reference.kind
    || pinned.evidenceHash !== result?.evidence?.evidenceHash
    || stableJson(result?.descriptor) !== stableJson(normalized)
  ) {
    throw new Error('cold_build_worker_image_evidence_invalid');
  }
  return result;
}

export function verifyRetainedImmutableColdBuildWorkerImage(result, imageReference) {
  const reference = normalizeImageReference(imageReference);
  let normalized;
  try {
    normalized = verifyProjection(result, reference);
  } catch {
    throw new Error('cold_build_worker_image_retained_evidence_invalid');
  }
  if (
    !exactKeys(result, ['descriptor', 'evidence'])
    || !exactKeys(result.descriptor, [
      'imageId',
      'operatingSystem',
      'architecture',
      'environment',
      'repoDigests',
    ])
    || !exactKeys(result.evidence, [
      'schemaVersion',
      'proofAuthority',
      'requestedImageReferenceHash',
      'requestedImageReferenceKind',
      'imageId',
      'operatingSystem',
      'architecture',
      'descriptorHash',
      'environmentHash',
      'repoDigestSetHash',
      'acceptedAsWorkerImageEvidence',
      'acceptedForGpuHmr',
      'gpuHmrSuccess',
      'canSatisfyRuntimeProof',
      'canSatisfyDispatchProof',
      'evidenceHash',
    ])
    || stableJson(result.descriptor) !== stableJson(normalized)
  ) {
    throw new Error('cold_build_worker_image_retained_evidence_invalid');
  }
  return result;
}

function workerImageReceiptAccepted(receipt) {
  return exactKeys(receipt, WORKER_IMAGE_RECEIPT_KEYS)
    && receipt.schemaVersion === COLD_BUILD_WORKER_IMAGE_RECEIPT_SCHEMA
    && receipt.proofAuthority === COLD_BUILD_WORKER_IMAGE_RECEIPT_AUTHORITY
    && [
      'requestedImageReferenceHash',
      'imageId',
      'descriptorHash',
      'environmentHash',
      'repoDigestSetHash',
      'inspectionEvidenceHash',
      'evidenceHash',
    ].every((name) => SHA256_PATTERN.test(receipt[name] ?? ''))
    && ['image_id', 'repo_digest'].includes(receipt.requestedImageReferenceKind)
    && receipt.operatingSystem === 'linux'
    && ['amd64', 'arm64'].includes(receipt.architecture)
    && Number.isSafeInteger(receipt.environmentEntryCount)
    && receipt.environmentEntryCount >= 0
    && receipt.environmentEntryCount <= 256
    && Number.isSafeInteger(receipt.repoDigestCount)
    && receipt.repoDigestCount >= 0
    && receipt.repoDigestCount <= 256
    && receipt.environmentValuesEmbedded === false
    && receipt.repoDigestValuesEmbedded === false
    && receipt.acceptedAsWorkerImageReceipt === true
    && receipt.acceptedAsWorkerImageEvidence === false
    && receipt.acceptedForGpuHmr === false
    && receipt.gpuHmrSuccess === false
    && receipt.canSatisfyRuntimeProof === false
    && receipt.canSatisfyDispatchProof === false
    && receipt.evidenceHash === recomputeEvidenceHash(receipt);
}

export function createColdBuildWorkerImageReceipt(result, imageReference) {
  verifyImmutableColdBuildWorkerImage(result, imageReference);
  const receipt = {
    schemaVersion: COLD_BUILD_WORKER_IMAGE_RECEIPT_SCHEMA,
    proofAuthority: COLD_BUILD_WORKER_IMAGE_RECEIPT_AUTHORITY,
    requestedImageReferenceHash: result.evidence.requestedImageReferenceHash,
    requestedImageReferenceKind: result.evidence.requestedImageReferenceKind,
    imageId: result.descriptor.imageId,
    operatingSystem: result.descriptor.operatingSystem,
    architecture: result.descriptor.architecture,
    descriptorHash: result.evidence.descriptorHash,
    environmentHash: result.evidence.environmentHash,
    environmentEntryCount: result.descriptor.environment.length,
    repoDigestSetHash: result.evidence.repoDigestSetHash,
    repoDigestCount: result.descriptor.repoDigests.length,
    inspectionEvidenceHash: result.evidence.evidenceHash,
    environmentValuesEmbedded: false,
    repoDigestValuesEmbedded: false,
    acceptedAsWorkerImageReceipt: true,
    acceptedAsWorkerImageEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  receipt.evidenceHash = recomputeEvidenceHash(receipt);
  if (!workerImageReceiptAccepted(receipt)) {
    throw new Error('cold_build_worker_image_receipt_source_invalid');
  }
  return receipt;
}

export function verifyColdBuildWorkerImageReceipt(receipt) {
  if (!workerImageReceiptAccepted(receipt)) {
    throw new Error('cold_build_worker_image_receipt_invalid');
  }
  return receipt;
}
