import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  VISUAL_CHANGE_OBLIGATION_TYPES,
  createVisualChangeObligationDeclaration,
  createVisualChangeObligationFulfillment,
  verifyVisualChangeObligationDeclaration,
  verifyVisualChangeObligationFulfillment,
} from '../lib/gpu-hmr-visual-change-obligations.mjs';

function hash(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function clone(value) {
  return structuredClone(value);
}

const predicate = {
  metricVersion: 'pixel_delta_thresholds.v1',
  minChangedPixelRatio: 0.05,
  minMeanAbsDelta: 1,
  requireDistinctRegionHashes: true,
};

const declaration = createVisualChangeObligationDeclaration({
  sourceManifestHash: hash('ordinary-source-manifest'),
  editContractHash: hash('typed-edit-contract'),
  renderStateManifestHash: hash('render-state-manifest'),
  deterministicVisualModeHash: hash('deterministic-controls'),
  obligations: [
    {
      type: VISUAL_CHANGE_OBLIGATION_TYPES.roi,
      selector: { x: 8, y: 16, width: 64, height: 48 },
      predicate,
    },
    {
      type: VISUAL_CHANGE_OBLIGATION_TYPES.tile,
      selector: {
        frameWidth: 128,
        frameHeight: 96,
        tileWidth: 32,
        tileHeight: 32,
        tileIndices: [0, 1, 5, 6],
      },
      predicate: { ...predicate, minChangedPixelRatio: 0.1 },
    },
  ],
});
assert.equal(verifyVisualChangeObligationDeclaration(declaration), declaration);
assert.match(declaration.declarationHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(declaration.acceptedForGpuHmr, false);
assert.equal(declaration.gpuHmrSuccess, false);

const [first, second] = declaration.obligations;
const fulfillment = createVisualChangeObligationFulfillment({
  declaration,
  sourceManifestHash: declaration.sourceManifestHash,
  editContractHash: declaration.editContractHash,
  renderStateManifestHash: declaration.renderStateManifestHash,
  deterministicVisualModeHash: declaration.deterministicVisualModeHash,
  runtimeSessionHash: hash('runtime-session'),
  processIdentityHash: hash('stable-process-identity'),
  deviceIdentityHash: hash('stable-device-identity'),
  swapchainIdentityHash: hash('stable-swapchain-identity'),
  captureBackendIdentityHash: hash('capture-backend-binary-and-config'),
  presentationBoundaryHash: hash('post-dispatch-presentation-boundary'),
  asyncVisualProofJobHash: hash('off-main-thread-job'),
  epoch: 2,
  dispatchId: 'dispatch:2',
  outputTargetId: 'framebuffer:0',
  frameNumber: 42,
  dispatchTimestampMonotonicNs: '1000000',
  captureTimestampMonotonicNs: '1000100',
  beforeImageHash: hash('before-image-bytes'),
  afterImageHash: hash('after-image-bytes'),
  diffImageHash: hash('diff-image-bytes'),
  frameWidth: 128,
  frameHeight: 96,
  results: [
    {
      obligationId: first.obligationId,
      beforeRegionHash: hash('roi-before'),
      afterRegionHash: hash('roi-after'),
      diffRegionHash: hash('roi-diff'),
      changedPixelRatio: 0.25,
      meanAbsDelta: 12,
    },
    {
      obligationId: second.obligationId,
      beforeRegionHash: hash('tiles-before'),
      afterRegionHash: hash('tiles-after'),
      diffRegionHash: hash('tiles-diff'),
      changedPixelRatio: 0.5,
      meanAbsDelta: 18,
      changedTileIndices: [1, 5],
      tileListHash: hashJson([1, 5]),
    },
  ],
});
assert.equal(verifyVisualChangeObligationFulfillment(fulfillment, declaration), fulfillment);
assert.equal(fulfillment.acceptedAsSupportEvidence, true);
assert.equal(fulfillment.acceptedForGpuHmr, false);
assert.equal(fulfillment.gpuHmrSuccess, false);
assert.match(fulfillment.bindingHash, /^sha256:[a-f0-9]{64}$/);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

const invalidDeclarations = [
  (value) => { value.obligations[0].description = 'descriptive scene vocabulary is not proof'; },
  (value) => { value.obligations[0].type = 'material_response'; },
  (value) => { value.obligations[0].obligationId = hash('forged-obligation-id'); },
  (value) => { value.acceptedForGpuHmr = true; },
  (value) => { value.canSatisfyRuntimeProof = true; },
  (value) => { value.obligations[0].selector.width = 0; },
  (value) => { value.obligations[1].selector.tileIndices = [0, 0]; },
  (value) => { value.declarationHash = hash('stale-declaration'); },
];
for (const mutate of invalidDeclarations) {
  const candidate = clone(declaration);
  mutate(candidate);
  assert.throws(
    () => verifyVisualChangeObligationDeclaration(candidate),
    /visual_change_obligation_/,
  );
}

const invalidFulfillments = [
  (value) => { value.gpuHmrSuccess = true; },
  (value) => { value.results[0].description = 'human label injection'; },
  (value) => { value.results[0].afterRegionHash = value.results[0].beforeRegionHash; },
  (value) => { value.results[0].changedPixelRatio = 0; },
  (value) => { value.results[1].changedTileIndices = [2]; },
  (value) => { value.results[1].tileListHash = hash('forged-list'); },
  (value) => { value.captureTimestampMonotonicNs = value.dispatchTimestampMonotonicNs; },
  (value) => { value.sourceManifestHash = hash('different-source'); },
  (value) => { value.beforeImageHash = value.afterImageHash; },
  (value) => { value.results.reverse(); },
  (value) => { value.results[0].evidenceRefs = []; },
  (value) => { value.bindingHash = hash('forged-binding'); },
];
for (const mutate of invalidFulfillments) {
  const candidate = clone(fulfillment);
  mutate(candidate);
  assert.throws(
    () => verifyVisualChangeObligationFulfillment(candidate, declaration),
    /visual_change_obligation_/,
  );
}

assert.throws(
  () => createVisualChangeObligationDeclaration({
    sourceManifestHash: hash('source'),
    editContractHash: hash('edit'),
    renderStateManifestHash: hash('render-state'),
    deterministicVisualModeHash: hash('mode'),
    obligations: [{
      type: VISUAL_CHANGE_OBLIGATION_TYPES.roi,
      selector: { x: 0, y: 0, width: 8, height: 8 },
      predicate,
      projectName: 'forbidden-shortcut',
    }],
  }),
  /declaration_entry_shape_invalid/,
);

const outOfBoundsDeclaration = createVisualChangeObligationDeclaration({
  sourceManifestHash: hash('ordinary-source-manifest'),
  editContractHash: hash('typed-edit-contract'),
  renderStateManifestHash: hash('render-state-manifest'),
  deterministicVisualModeHash: hash('deterministic-controls'),
  obligations: [{
    type: VISUAL_CHANGE_OBLIGATION_TYPES.roi,
    selector: { x: 120, y: 90, width: 16, height: 16 },
    predicate,
  }],
});
assert.throws(
  () => createVisualChangeObligationFulfillment({
    declaration: outOfBoundsDeclaration,
    sourceManifestHash: outOfBoundsDeclaration.sourceManifestHash,
    editContractHash: outOfBoundsDeclaration.editContractHash,
    renderStateManifestHash: outOfBoundsDeclaration.renderStateManifestHash,
    deterministicVisualModeHash: outOfBoundsDeclaration.deterministicVisualModeHash,
    runtimeSessionHash: hash('runtime-session'),
    processIdentityHash: hash('process'),
    deviceIdentityHash: hash('device'),
    swapchainIdentityHash: hash('swapchain'),
    captureBackendIdentityHash: hash('capture-backend'),
    presentationBoundaryHash: hash('presentation-boundary'),
    asyncVisualProofJobHash: hash('job'),
    epoch: 1,
    dispatchId: 'dispatch:1',
    outputTargetId: 'framebuffer:0',
    frameNumber: 7,
    dispatchTimestampMonotonicNs: '1',
    captureTimestampMonotonicNs: '2',
    beforeImageHash: hash('before'),
    afterImageHash: hash('after'),
    diffImageHash: hash('diff'),
    frameWidth: 128,
    frameHeight: 96,
    results: [{
      obligationId: outOfBoundsDeclaration.obligations[0].obligationId,
      beforeRegionHash: hash('region-before'),
      afterRegionHash: hash('region-after'),
      diffRegionHash: hash('region-diff'),
      changedPixelRatio: 0.5,
      meanAbsDelta: 10,
    }],
  }),
  /fulfillment_roi_out_of_bounds/,
);

const serialized = JSON.stringify({ declaration, fulfillment });
assert.doesNotMatch(
  serialized,
  /diamond|lighting|material|neural|flow|hiprt|projectName|fixtureName/i,
);

console.log(JSON.stringify({
  status: 'self_check_passed',
  declarationHash: declaration.declarationHash,
  fulfillmentBindingHash: fulfillment.bindingHash,
  obligationCount: declaration.obligations.length,
  descriptiveFieldsRejected: true,
  authorityClaimsRejected: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
}, null, 2));
