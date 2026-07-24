#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';
import {
  GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
} from '../lib/gpu-hmr-visual-proof-worker.mjs';
import {
  GPU_HMR_ASYNC_VISUAL_PROOF_JOB_AUTHORITY,
  GPU_HMR_ASYNC_VISUAL_PROOF_JOB_SCHEMA_VERSION,
} from '../lib/gpu-hmr-visual-evidence.mjs';

const {
  asyncVisualCasBundleFacet,
  asyncVisualProofJobBindingFacet,
  recomputedAsyncVisualProofJobHash,
  summarizeAsyncVisualProof,
} = GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS;
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

const missingEvent = summarizeAsyncVisualProof({
  schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
});
assert.equal(missingEvent.eventType, null);
assert.equal(missingEvent.event_type, null);

const explicitReady = summarizeAsyncVisualProof({
  schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  eventType: 'proof_ready',
  proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
});
assert.equal(explicitReady.eventType, 'proof_ready');
assert.equal(explicitReady.event_type, 'proof_ready');

const explicitPending = summarizeAsyncVisualProof({
  schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  event_type: 'proof_pending',
  proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  accepted: false,
  acceptedAsAsyncVisualMetrics: false,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
});
assert.equal(explicitPending.eventType, 'proof_pending');
assert.equal(explicitPending.event_type, 'proof_pending');

const conflictingAliases = summarizeAsyncVisualProof({
  schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  eventType: 'proof_ready',
  event_type: 'proof_pending',
  proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
});
assert.equal(conflictingAliases.eventType, null);
assert.equal(conflictingAliases.event_type, null);

const malformedDuplicateAlias = summarizeAsyncVisualProof({
  schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  eventType: 'proof_ready',
  event_type: ' ',
  proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
});
assert.equal(malformedDuplicateAlias.eventType, null);
assert.equal(malformedDuplicateAlias.event_type, null);

const missingAuthority = summarizeAsyncVisualProof({
  eventType: 'proof_ready',
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
});
assert.equal(missingAuthority.schemaVersion, null);
assert.equal(missingAuthority.proofAuthority, null);

const conflictingAuthority = summarizeAsyncVisualProof({
  schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  eventType: 'proof_ready',
  proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: false,
});
assert.equal(conflictingAuthority.aliasConflict, true);
assert.equal(conflictingAuthority.acceptedForGpuHmr, null);

const conflictingNestedMetrics = summarizeAsyncVisualProof({
  schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  eventType: 'proof_ready',
  proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  inputHashes: {
    beforeEncodedHash: HASH_A,
    before_encoded_hash: HASH_B,
  },
  incremental: {
    tileHashing: true,
    tile_hashing: false,
  },
});
assert.equal(conflictingNestedMetrics.aliasConflict, true);
assert.equal(conflictingNestedMetrics.eventType, null);

const prototypeKeyProof = summarizeAsyncVisualProof(JSON.parse(
  '{"__proto__":{"eventType":"proof_ready","accepted":true,'
    + '"acceptedAsAsyncVisualMetrics":true}}',
));
assert.equal(prototypeKeyProof.eventType, null);
assert.equal(prototypeKeyProof.accepted, false);

const inheritedProof = Object.create({
  eventType: 'proof_ready',
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
});
assert.equal(summarizeAsyncVisualProof(inheritedProof).aliasConflict, true);

const proxiedProof = new Proxy({
  eventType: 'proof_ready',
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
}, {});
assert.equal(summarizeAsyncVisualProof(proxiedProof).aliasConflict, true);

const openVocabularyExtensions = summarizeAsyncVisualProof({
  schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  eventType: 'proof_ready',
  proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  accepted: true,
  acceptedAsAsyncVisualMetrics: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  extensions: {
    probe_id: 'extension-one',
    probeId: 'extension-two',
  },
  inputArtifacts: {
    probe_id: { contentHash: HASH_A },
    probeId: { contentHash: HASH_B },
  },
});
assert.equal(openVocabularyExtensions.aliasConflict, false);
assert.equal(openVocabularyExtensions.eventType, 'proof_ready');

const retainedConflict = asyncVisualCasBundleFacet({}, {
  recomputedVisualPair: {
    asyncVisualMetrics: {
      eventType: 'proof_ready',
      event_type: 'proof_pending',
      accepted: true,
      acceptedAsAsyncVisualMetrics: true,
    },
  },
});
assert.equal(retainedConflict.proofReady, false);
assert.ok(retainedConflict.failedGates.includes('async_visual_proof_ready_event_missing'));

const conflictingJobAliases = asyncVisualProofJobBindingFacet({
  eventType: 'proof_pending',
  event_type: 'proof_ready',
  proofPending: true,
  proof_pending: true,
  proofReady: false,
  proof_ready: false,
});
assert.equal(conflictingJobAliases.accepted, false);
assert.ok(conflictingJobAliases.failedGates.includes(
  'async_visual_proof_job_alias_conflict',
));

const conflictingJobFlags = asyncVisualProofJobBindingFacet({
  eventType: 'proof_pending',
  event_type: 'proof_pending',
  proofPending: true,
  proof_pending: false,
  proofReady: false,
  proof_ready: false,
});
assert.equal(conflictingJobFlags.accepted, false);
assert.ok(conflictingJobFlags.failedGates.includes(
  'async_visual_proof_job_alias_conflict',
));

const conflictingJobAuthority = asyncVisualProofJobBindingFacet({
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: true,
  gpuHmrSuccess: false,
  gpu_hmr_success: true,
});
assert.equal(conflictingJobAuthority.accepted, false);
assert.ok(conflictingJobAuthority.failedGates.includes(
  'async_visual_proof_job_alias_conflict',
));

const conflictingNestedJobAuthority = asyncVisualProofJobBindingFacet({
  jobManifestLocator: {
    contentHash: HASH_A,
    content_hash: HASH_B,
  },
  visualArtifactTransportEvidence: {
    proofAuthority: 'transport_integrity_only_not_visual_or_ledger_proof',
    proof_authority: 'forged_authority',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: true,
    gpuHmrSuccess: false,
    gpu_hmr_success: true,
  },
});
assert.equal(conflictingNestedJobAuthority.accepted, false);
assert.ok(conflictingNestedJobAuthority.failedGates.includes(
  'async_visual_proof_job_alias_conflict',
));

const validAliasPreservingJobBase = {
  schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_JOB_SCHEMA_VERSION,
  schema_version: GPU_HMR_ASYNC_VISUAL_PROOF_JOB_SCHEMA_VERSION,
  eventType: 'proof_pending',
  event_type: 'proof_pending',
  proofPending: true,
  proof_pending: true,
  proofReady: false,
  proof_ready: false,
  accepted: false,
  acceptedAsAsyncVisualProofJob: true,
  accepted_as_async_visual_proof_job: true,
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: false,
  gpuHmrSuccess: false,
  gpu_hmr_success: false,
  proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_JOB_AUTHORITY,
  proof_authority: GPU_HMR_ASYNC_VISUAL_PROOF_JOB_AUTHORITY,
  artifactCasLocators: [{ role: 'before' }, { role: 'after' }],
  visualArtifactTransportEvidence: {
    accepted: true,
    acceptedAsTransportEvidence: true,
    proofAuthority: 'transport_integrity_only_not_visual_or_ledger_proof',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
  },
};
const validAliasPreservingJobHash = recomputedAsyncVisualProofJobHash(
  validAliasPreservingJobBase,
);
const validAliasPreservingJob = asyncVisualProofJobBindingFacet({
  ...validAliasPreservingJobBase,
  jobHash: validAliasPreservingJobHash,
  jobManifestHash: validAliasPreservingJobHash,
  jobManifestLocator: { contentHash: validAliasPreservingJobHash },
});
assert.equal(validAliasPreservingJob.accepted, true);
assert.deepEqual(validAliasPreservingJob.failedGates, []);

console.log('GPU HMR async visual proof-ready self-check passed.');
