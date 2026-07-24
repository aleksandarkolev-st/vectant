import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  COLD_BUILD_WORKER_IMAGE_EVIDENCE_AUTHORITY,
  COLD_BUILD_WORKER_IMAGE_EVIDENCE_SCHEMA,
  COLD_BUILD_WORKER_IMAGE_RECEIPT_AUTHORITY,
  COLD_BUILD_WORKER_IMAGE_RECEIPT_SCHEMA,
  verifyColdBuildWorkerImageReceipt,
  verifyRetainedImmutableColdBuildWorkerImage,
} from '../lib/gpu-hmr-cold-build-worker-image.mjs';

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
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function seal(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  value.evidenceHash = contentHash(stableJson(projection));
  return value;
}

const imageId = `sha256:${'1'.repeat(64)}`;
const repoDigest = `registry.example/provider@sha256:${'2'.repeat(64)}`;
const operatingSystem = 'provider-defined-os/future-v7';
const architecture = 'provider-defined-machine/future-v11';
const descriptor = {
  imageId,
  operatingSystem,
  architecture,
  environment: [],
  repoDigests: [repoDigest],
};
const descriptorHash = contentHash(stableJson(descriptor));
const evidence = seal({
  schemaVersion: COLD_BUILD_WORKER_IMAGE_EVIDENCE_SCHEMA,
  proofAuthority: COLD_BUILD_WORKER_IMAGE_EVIDENCE_AUTHORITY,
  requestedImageReferenceHash: contentHash(repoDigest),
  requestedImageReferenceKind: 'repo_digest',
  imageId,
  operatingSystem,
  architecture,
  descriptorHash,
  environmentHash: contentHash(stableJson([])),
  repoDigestSetHash: contentHash(stableJson([repoDigest])),
  acceptedAsWorkerImageEvidence: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  canSatisfyRuntimeProof: false,
  canSatisfyDispatchProof: false,
});
const retained = { descriptor, evidence };

assert.equal(
  verifyRetainedImmutableColdBuildWorkerImage(retained, repoDigest),
  retained,
);

const receipt = seal({
  schemaVersion: COLD_BUILD_WORKER_IMAGE_RECEIPT_SCHEMA,
  proofAuthority: COLD_BUILD_WORKER_IMAGE_RECEIPT_AUTHORITY,
  requestedImageReferenceHash: evidence.requestedImageReferenceHash,
  requestedImageReferenceKind: evidence.requestedImageReferenceKind,
  imageId,
  operatingSystem,
  architecture,
  descriptorHash,
  environmentHash: evidence.environmentHash,
  environmentEntryCount: 0,
  repoDigestSetHash: evidence.repoDigestSetHash,
  repoDigestCount: 1,
  inspectionEvidenceHash: evidence.evidenceHash,
  environmentValuesEmbedded: false,
  repoDigestValuesEmbedded: false,
  acceptedAsWorkerImageReceipt: true,
  acceptedAsWorkerImageEvidence: false,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  canSatisfyRuntimeProof: false,
  canSatisfyDispatchProof: false,
});

assert.equal(verifyColdBuildWorkerImageReceipt(receipt), receipt);

for (const invalidLabel of ['', 'line\nbreak', 'nul\0byte']) {
  const invalid = structuredClone(retained);
  invalid.descriptor.architecture = invalidLabel;
  invalid.evidence.architecture = invalidLabel;
  invalid.evidence.descriptorHash = contentHash(stableJson(invalid.descriptor));
  seal(invalid.evidence);
  assert.throws(
    () => verifyRetainedImmutableColdBuildWorkerImage(invalid, repoDigest),
    /retained_evidence_invalid/,
  );
}

console.log(JSON.stringify({
  status: 'self_check_passed',
  openVocabularyProviderIdentityAccepted: true,
  immutableImageBindingRequired: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
}, null, 2));
