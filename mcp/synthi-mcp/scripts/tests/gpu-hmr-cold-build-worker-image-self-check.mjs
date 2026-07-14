import assert from 'node:assert/strict';

import { COLD_BUILD_LAUNCHER_BUILDER_IMAGE } from '../lib/gpu-hmr-cold-build-container-contract.mjs';
import {
  COLD_BUILD_WORKER_IMAGE_EVIDENCE_AUTHORITY,
  COLD_BUILD_WORKER_IMAGE_EVIDENCE_SCHEMA,
  inspectImmutableColdBuildWorkerImage,
  verifyImmutableColdBuildWorkerImage,
} from '../lib/gpu-hmr-cold-build-worker-image.mjs';

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
