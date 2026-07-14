import assert from 'node:assert/strict';

import { COLD_BUILD_LAUNCHER_BUILDER_IMAGE } from '../lib/gpu-hmr-cold-build-container-contract.mjs';
import {
  COLD_BUILD_WORKER_IMAGE_EVIDENCE_AUTHORITY,
  COLD_BUILD_WORKER_IMAGE_EVIDENCE_SCHEMA,
  inspectImmutableColdBuildWorkerImage,
  verifyImmutableColdBuildWorkerImage,
  verifyRetainedImmutableColdBuildWorkerImage,
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
