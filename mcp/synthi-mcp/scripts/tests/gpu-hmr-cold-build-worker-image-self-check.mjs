import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { COLD_BUILD_LAUNCHER_BUILDER_IMAGE } from '../lib/gpu-hmr-cold-build-container-contract.mjs';
import {
  COLD_BUILD_WORKER_IMAGE_EVIDENCE_AUTHORITY,
  COLD_BUILD_WORKER_IMAGE_EVIDENCE_SCHEMA,
  COLD_BUILD_WORKER_IMAGE_RECEIPT_AUTHORITY,
  COLD_BUILD_WORKER_IMAGE_RECEIPT_SCHEMA,
  createColdBuildWorkerImageReceipt,
  inspectImmutableColdBuildWorkerImage,
  verifyColdBuildWorkerImageReceipt,
  verifyImmutableColdBuildWorkerImage,
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

function resealEvidence(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  value.evidenceHash = `sha256:${createHash('sha256')
    .update(stableJson(projection))
    .digest('hex')}`;
}

const digestResult = await inspectImmutableColdBuildWorkerImage(
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
);
assert.equal(
  verifyImmutableColdBuildWorkerImage(digestResult, COLD_BUILD_LAUNCHER_BUILDER_IMAGE),
  digestResult,
);
assert.equal(digestResult.evidence.schemaVersion, COLD_BUILD_WORKER_IMAGE_EVIDENCE_SCHEMA);
assert.equal(digestResult.evidence.proofAuthority, COLD_BUILD_WORKER_IMAGE_EVIDENCE_AUTHORITY);
assert.equal(digestResult.evidence.requestedImageReferenceKind, 'repo_digest');
assert.equal(digestResult.evidence.acceptedAsWorkerImageEvidence, true);
assert.equal(digestResult.evidence.acceptedForGpuHmr, false);
assert.equal(digestResult.evidence.gpuHmrSuccess, false);
assert.equal(digestResult.evidence.canSatisfyRuntimeProof, false);
assert.equal(digestResult.evidence.canSatisfyDispatchProof, false);

const idResult = await inspectImmutableColdBuildWorkerImage(digestResult.descriptor.imageId);
assert.equal(
  verifyImmutableColdBuildWorkerImage(idResult, digestResult.descriptor.imageId),
  idResult,
);
assert.equal(idResult.evidence.requestedImageReferenceKind, 'image_id');
assert.equal(idResult.descriptor.imageId, digestResult.descriptor.imageId);
assert.notEqual(idResult.evidence.evidenceHash, digestResult.evidence.evidenceHash);
const retainedIdResult = JSON.parse(JSON.stringify(idResult));
assert.equal(
  verifyRetainedImmutableColdBuildWorkerImage(
    retainedIdResult,
    digestResult.descriptor.imageId,
  ),
  retainedIdResult,
);
const retainedDigestResult = JSON.parse(JSON.stringify(digestResult));
assert.equal(
  verifyRetainedImmutableColdBuildWorkerImage(
    retainedDigestResult,
    COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  ),
  retainedDigestResult,
);
const workerImageReceipt = createColdBuildWorkerImageReceipt(
  digestResult,
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
);
const retainedWorkerImageReceipt = JSON.parse(JSON.stringify(workerImageReceipt));
assert.equal(workerImageReceipt.schemaVersion, COLD_BUILD_WORKER_IMAGE_RECEIPT_SCHEMA);
assert.equal(workerImageReceipt.proofAuthority, COLD_BUILD_WORKER_IMAGE_RECEIPT_AUTHORITY);
assert.equal(workerImageReceipt.environmentValuesEmbedded, false);
assert.equal(workerImageReceipt.repoDigestValuesEmbedded, false);
assert.equal(workerImageReceipt.acceptedAsWorkerImageReceipt, true);
assert.equal(workerImageReceipt.acceptedAsWorkerImageEvidence, false);
assert.equal(workerImageReceipt.acceptedForGpuHmr, false);
assert.equal(workerImageReceipt.gpuHmrSuccess, false);
assert.equal(
  verifyColdBuildWorkerImageReceipt(retainedWorkerImageReceipt),
  retainedWorkerImageReceipt,
);
const serializedWorkerImageReceipt = JSON.stringify(workerImageReceipt);
for (const value of [
  ...digestResult.descriptor.environment,
  ...digestResult.descriptor.repoDigests,
]) {
  assert.equal(serializedWorkerImageReceipt.includes(value), false);
}
assert.throws(
  () => createColdBuildWorkerImageReceipt(
    structuredClone(digestResult),
    COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  ),
  /evidence_invalid/,
);
const forgedWorkerImageReceiptAuthority = structuredClone(retainedWorkerImageReceipt);
forgedWorkerImageReceiptAuthority.acceptedAsWorkerImageEvidence = true;
forgedWorkerImageReceiptAuthority.acceptedForGpuHmr = true;
resealEvidence(forgedWorkerImageReceiptAuthority);
assert.throws(
  () => verifyColdBuildWorkerImageReceipt(forgedWorkerImageReceiptAuthority),
  /receipt_invalid/,
);
const retainedResultWithUnknownField = structuredClone(retainedIdResult);
retainedResultWithUnknownField.projectName = 'must-not-be-accepted';
assert.throws(
  () => verifyRetainedImmutableColdBuildWorkerImage(
    retainedResultWithUnknownField,
    digestResult.descriptor.imageId,
  ),
  /retained_evidence_invalid/,
);
const retainedAuthorityClaim = structuredClone(retainedIdResult);
retainedAuthorityClaim.evidence.gpuHmrSuccess = true;
assert.throws(
  () => verifyRetainedImmutableColdBuildWorkerImage(
    retainedAuthorityClaim,
    digestResult.descriptor.imageId,
  ),
  /retained_evidence_invalid/,
);

await assert.rejects(
  () => inspectImmutableColdBuildWorkerImage('golang:mutable-tag'),
  /reference_not_immutable/,
);
assert.throws(
  () => verifyImmutableColdBuildWorkerImage(
    structuredClone(idResult),
    digestResult.descriptor.imageId,
  ),
  /evidence_invalid/,
);
idResult.evidence.acceptedForGpuHmr = true;
assert.throws(
  () => verifyImmutableColdBuildWorkerImage(idResult, digestResult.descriptor.imageId),
  /evidence_invalid/,
);
idResult.evidence.acceptedForGpuHmr = false;
assert.equal(
  verifyImmutableColdBuildWorkerImage(idResult, digestResult.descriptor.imageId),
  idResult,
);
assert.ok(!JSON.stringify(idResult).match(/miopen|hiprt|flow|diamond|neural|blas|fixture/i));

console.log(JSON.stringify({
  status: 'self_check_passed',
  schemaVersion: idResult.evidence.schemaVersion,
  imageId: idResult.descriptor.imageId,
  architecture: idResult.descriptor.architecture,
  immutableTagRejected: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
}, null, 2));
