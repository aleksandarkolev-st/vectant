#!/usr/bin/env node
import assert from 'node:assert/strict';
import { externalVisualStateBindingFacet } from '../lib/gpu-hmr-validation-matrix-ledger.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;

const legacyMatchingHashes = externalVisualStateBindingFacet({
  visualArtifacts: {
    camera_state_hash: hash('a'),
  },
  deterministicVisualMode: {
    camera_state_hash: hash('a'),
    seed_policy_hash: hash('b'),
  },
  requiredContentHashes: [hash('c'), hash('d'), hash('e')],
});

assert.equal(legacyMatchingHashes.cameraHashesMatch, true);
assert.equal(legacyMatchingHashes.accepted, false);
assert.equal(legacyMatchingHashes.acceptedForGpuHmr, false);
assert.equal(legacyMatchingHashes.gpuHmrSuccess, false);
assert.equal(legacyMatchingHashes.canSatisfyRuntimeProof, false);
assert.equal(
  legacyMatchingHashes.proofAuthority,
  'deprecated_report_derived_visual_state_binding_not_runtime_proof',
);
assert.ok(legacyMatchingHashes.failedGates.includes(
  'external_visual_state_binding_deprecated_without_target_process_attestation',
));

const missingHashes = externalVisualStateBindingFacet();
assert.equal(missingHashes.accepted, false);
assert.ok(missingHashes.failedGates.includes('external_visual_state_camera_hash_missing'));
assert.ok(missingHashes.failedGates.includes('external_visual_state_seed_hash_missing'));

console.log(JSON.stringify({
  ok: true,
  schemaVersion: legacyMatchingHashes.schemaVersion,
  legacyMatchingHashesRefused: legacyMatchingHashes.accepted === false,
  failedGates: legacyMatchingHashes.failedGates,
}, null, 2));
