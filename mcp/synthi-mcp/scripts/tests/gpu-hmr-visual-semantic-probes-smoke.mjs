#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildGpuHmrValidationMatrixLedger,
  GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
  GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function hashValue(label) {
  return `sha256:${sha256Hex(label)}`;
}

function contentHashFor(value) {
  return `sha256:${sha256Hex(stableJson(value))}`;
}

function semanticProbeBindingPayload({
  beforeImageHash,
  afterImageHash,
  diffImageHash,
  visualSceneManifestHash,
  deterministicVisualModeHash,
  probes,
}) {
  return {
    schemaVersion: 'synthi.gpu_hmr.visual_semantic_probe_binding.v1',
    schema_version: 'synthi.gpu_hmr.visual_semantic_probe_binding.v1',
    proofAuthority: 'semantic_visual_probe_binding_only_not_gpu_hmr_success',
    proof_authority: 'semantic_visual_probe_binding_only_not_gpu_hmr_success',
    beforeImageHash,
    before_image_hash: beforeImageHash,
    afterImageHash,
    after_image_hash: afterImageHash,
    diffImageHash,
    diff_image_hash: diffImageHash,
    visualSceneManifestHash,
    visual_scene_manifest_hash: visualSceneManifestHash,
    deterministicVisualModeHash,
    deterministic_visual_mode_hash: deterministicVisualModeHash,
    probes: probes.map((probe) => ({
      probeId: probe.probeId,
      probe_id: probe.probe_id,
      probeClass: probe.probeClass,
      probe_class: probe.probe_class,
      source: probe.source,
      beforeRegionHash: probe.beforeRegionHash,
      before_region_hash: probe.before_region_hash,
      afterRegionHash: probe.afterRegionHash,
      after_region_hash: probe.after_region_hash,
      diffRegionHash: probe.diffRegionHash,
      diff_region_hash: probe.diff_region_hash,
      tileBindingHash: probe.tileBindingHash,
      tile_binding_hash: probe.tile_binding_hash,
      roiBindingHash: probe.roiBindingHash,
      roi_binding_hash: probe.roi_binding_hash,
      region: probe.region,
      changedPixelRatio: probe.changedPixelRatio,
      changed_pixel_ratio: probe.changed_pixel_ratio,
      meanAbsDelta: probe.meanAbsDelta,
      mean_abs_delta: probe.mean_abs_delta,
      evidenceRefs: probe.evidenceRefs,
      evidence_refs: probe.evidence_refs,
    })),
  };
}

function semanticProbeEvidence({
  beforeImageHash,
  afterImageHash,
  diffImageHash,
  visualSceneManifestHash,
  deterministicVisualModeHash,
}) {
  const probes = [
    {
      probeId: 'material-response',
      probe_id: 'material-response',
      probeClass: 'material_response',
      probe_class: 'material_response',
      source: 'visual_worker_roi',
      beforeRegionHash: hashValue('material-before-region'),
      before_region_hash: hashValue('material-before-region'),
      afterRegionHash: hashValue('material-after-region'),
      after_region_hash: hashValue('material-after-region'),
      diffRegionHash: hashValue('material-diff-region'),
      diff_region_hash: hashValue('material-diff-region'),
      tileBindingHash: hashValue('semantic-tile-binding'),
      tile_binding_hash: hashValue('semantic-tile-binding'),
      roiBindingHash: hashValue('material-roi-binding'),
      roi_binding_hash: hashValue('material-roi-binding'),
      region: { x: 1, y: 1, width: 8, height: 8 },
      changedPixelRatio: 0.38,
      changed_pixel_ratio: 0.38,
      meanAbsDelta: 18.25,
      mean_abs_delta: 18.25,
      evidenceRefs: [beforeImageHash, afterImageHash, visualSceneManifestHash],
      evidence_refs: [beforeImageHash, afterImageHash, visualSceneManifestHash],
      accepted: true,
    },
    {
      probeId: 'lighting-response',
      probe_id: 'lighting-response',
      probeClass: 'lighting_response',
      probe_class: 'lighting_response',
      source: 'deterministic_oracle_region',
      beforeRegionHash: hashValue('lighting-before-region'),
      before_region_hash: hashValue('lighting-before-region'),
      afterRegionHash: hashValue('lighting-after-region'),
      after_region_hash: hashValue('lighting-after-region'),
      diffRegionHash: hashValue('lighting-diff-region'),
      diff_region_hash: hashValue('lighting-diff-region'),
      tileBindingHash: hashValue('semantic-tile-binding'),
      tile_binding_hash: hashValue('semantic-tile-binding'),
      roiBindingHash: hashValue('lighting-roi-binding'),
      roi_binding_hash: hashValue('lighting-roi-binding'),
      region: { x: 4, y: 2, width: 6, height: 8 },
      changedPixelRatio: 0.29,
      changed_pixel_ratio: 0.29,
      meanAbsDelta: 13.75,
      mean_abs_delta: 13.75,
      evidenceRefs: [diffImageHash, visualSceneManifestHash, deterministicVisualModeHash],
      evidence_refs: [diffImageHash, visualSceneManifestHash, deterministicVisualModeHash],
      accepted: true,
    },
  ];
  const payload = semanticProbeBindingPayload({
    beforeImageHash,
    afterImageHash,
    diffImageHash,
    visualSceneManifestHash,
    deterministicVisualModeHash,
    probes,
  });
  return {
    ...payload,
    probes,
    accepted: true,
    acceptedAsSemanticVisualProbeEvidence: true,
    accepted_as_semantic_visual_probe_evidence: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    bindingHash: contentHashFor(payload),
    binding_hash: contentHashFor(payload),
    evidenceRefs: [
      beforeImageHash,
      afterImageHash,
      diffImageHash,
      visualSceneManifestHash,
      deterministicVisualModeHash,
    ],
    evidence_refs: [
      beforeImageHash,
      afterImageHash,
      diffImageHash,
      visualSceneManifestHash,
      deterministicVisualModeHash,
    ],
  };
}

function baseRow({ targetId, semanticProbe }) {
  const beforeImageHash = hashValue(`${targetId}:before`);
  const afterImageHash = hashValue(`${targetId}:after`);
  const diffImageHash = hashValue(`${targetId}:diff`);
  const visualSceneManifestHash = hashValue(`${targetId}:scene-manifest`);
  const deterministicVisualModeHash = hashValue(`${targetId}:deterministic-mode`);
  return {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    backend: 'hip',
    targetId,
    profileId: targetId,
    proofMode: 'semantic_visual_probe_self_check',
    matrixOutcome: 'refusal_proven',
    acceptanceScope: 'not_full_runtime',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven: true,
    proofChainAccepted: true,
    proofChain: 'semantic_visual_probe_support_only',
    proofIds: [`semantic-visual-probe-self-check:${targetId}`],
    visual: {
      present: true,
      accepted: true,
      images: [
        { role: 'before', sha256: beforeImageHash },
        { role: 'after', sha256: afterImageHash },
        { role: 'diff', sha256: diffImageHash },
      ],
    },
    visualArtifacts: {
      beforeImageHash,
      afterImageHash,
      diffImageHash,
    },
    validationProfileEvidence: {
      schemaVersion: 'synthi.gpu.hmr.validation_profile_evidence.v1',
      accepted: true,
      profileId: targetId,
      profileClass: 'semantic_visual_probe_self_check',
      source: 'agent_split_run_mode_visual_ledger_recomputed',
      evidenceRefs: [
        beforeImageHash,
        afterImageHash,
        diffImageHash,
        visualSceneManifestHash,
        deterministicVisualModeHash,
      ],
      proofIds: [`semantic-visual-probe-self-check:${targetId}`],
    },
    visualSemanticProbes: semanticProbe({
      beforeImageHash,
      afterImageHash,
      diffImageHash,
      visualSceneManifestHash,
      deterministicVisualModeHash,
    }),
  };
}

const acceptedSupportRow = baseRow({
  targetId: 'semantic-probe-positive',
  semanticProbe: semanticProbeEvidence,
});
const supportLedger = buildGpuHmrValidationMatrixLedger([acceptedSupportRow], {
  generatedAt: '2026-07-05T00:00:00.000Z',
  includeUnproven: true,
  latestPerTarget: false,
});
assert.equal(supportLedger.schemaVersion, GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION);
const supportRow = supportLedger.rows.find((row) => row.targetId === 'semantic-probe-positive');
assert.equal(supportRow.visualSemanticProbes.accepted, true);
assert.equal(supportRow.visualSemanticProbes.materialProbeAccepted, true);
assert.equal(supportRow.visualSemanticProbes.lightingProbeAccepted, true);
assert.equal(supportRow.visualSemanticProbes.acceptedForGpuHmr, false);
assert.equal(supportRow.visualSemanticProbes.gpuHmrSuccess, false);
const supportCoverage = supportLedger.summary.planCoverage.find(
  (entry) => entry.id === 'semantic_realistic_visual_probes',
);
assert.equal(supportCoverage.status, 'support_only');
assert.equal(supportCoverage.acceptedProbeRowCount, 1);
assert.ok(supportCoverage.openGaps.includes(
  'semantic_visual_probes_support_only_not_gpu_hmr_authority',
));

const forgedRow = baseRow({
  targetId: 'semantic-probe-label-only',
  semanticProbe: ({
    beforeImageHash,
    afterImageHash,
    diffImageHash,
  }) => ({
    schemaVersion: 'synthi.gpu_hmr.visual_semantic_probe_binding.v1',
    proofAuthority: 'semantic_visual_probe_binding_only_not_gpu_hmr_success',
    accepted: true,
    acceptedAsSemanticVisualProbeEvidence: true,
    acceptedForGpuHmr: true,
    gpuHmrSuccess: true,
    canSatisfyRuntimeProof: true,
    beforeImageHash,
    afterImageHash,
    diffImageHash,
    visualSceneName: 'realistic diamond lighting label only',
    bindingHash: hashValue('forged-label-only-binding'),
    evidenceRefs: ['label:diamond', 'label:lighting'],
    probes: [{
      probeId: 'label-only',
      probeClass: 'diamond_lighting_label',
      source: 'serialized_label',
      region: { x: 0, y: 0, width: 8, height: 8 },
      changedPixelRatio: 0.5,
      meanAbsDelta: 9,
      accepted: true,
      evidenceRefs: ['label:diamond'],
    }],
  }),
});
forgedRow.matrixOutcome = 'full_runtime_gpu_hmr';
forgedRow.acceptanceScope = 'generated_rocm_hip_preview_visual';
forgedRow.acceptedForGpuHmr = true;
forgedRow.gpuHmrSuccess = true;
forgedRow.refusalProven = false;

const forgedLedger = buildGpuHmrValidationMatrixLedger([forgedRow], {
  generatedAt: '2026-07-05T00:00:00.100Z',
  includeInvalidated: true,
  includeUnproven: true,
  latestPerTarget: false,
});
const invalidated = forgedLedger.rows.find((row) => row.targetId === 'semantic-probe-label-only');
assert.equal(invalidated.visualSemanticProbes.accepted, false);
assert.equal(invalidated.safety.accepted, false);
assert.ok(invalidated.safety.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_cannot_use_unaccepted_visual_semantic_probe'
));
assert.ok(invalidated.visualSemanticProbes.failedGates.includes(
  'visual_semantic_probe_claims_gpu_hmr_acceptance',
));
assert.ok(invalidated.visualSemanticProbes.failedGates.includes(
  'visual_semantic_probe_material_lighting_classes_required',
));
assert.ok(invalidated.visualSemanticProbes.failedGates.includes(
  'visual_semantic_probe_scene_manifest_hash_missing',
));

const filteredForgedLedger = buildGpuHmrValidationMatrixLedger([forgedRow], {
  generatedAt: '2026-07-05T00:00:00.200Z',
  includeUnproven: true,
  latestPerTarget: false,
});
assert.equal(filteredForgedLedger.rows.length, 0);
assert.equal(filteredForgedLedger.summary.acceptedFullRuntimeGpuHmrRows, 0);

const profileBindingRow = {
  targetId: 'generated-gpu-split:source-first-alias',
  profileId: 'arbitrary-source-first-visual-profile',
  proofIds: [
    'gpu-ledger-proof:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'gpu-runtime-proof:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ],
  ledger: {
    proofId: 'gpu-ledger-proof:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    record: {
      projectId: 'workspace-project-123',
      proofId: 'gpu-ledger-proof:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  },
  runtimeProofArtifact: {
    proofId: 'gpu-runtime-proof:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
  sourceFirstIngestion: {
    accepted: true,
    targetId: 'generated-gpu-split:source-first-alias',
  },
};
const profileBindingEvidence = {
  profileId: 'arbitrary-source-first-visual-profile',
  source: 'agent_split_profile_runtime_visual_proof',
  proofIds: profileBindingRow.proofIds,
  profileHash: hashValue('profile-binding-profile'),
  sourceContentHash: hashValue('profile-binding-source'),
  deterministicVisualModeHash: hashValue('profile-binding-mode'),
  visualProofHash: hashValue('profile-binding-visual-proof'),
  visualSceneManifestHash: hashValue('profile-binding-scene'),
  evidenceRefs: [
    ...profileBindingRow.proofIds,
    'generated-gpu-split:source-first-alias',
    hashValue('profile-binding-profile'),
    hashValue('profile-binding-source'),
    hashValue('profile-binding-mode'),
    hashValue('profile-binding-visual-proof'),
    hashValue('profile-binding-scene'),
  ],
};
profileBindingRow.evidenceRefs = profileBindingEvidence.evidenceRefs;
profileBindingRow.evidence_refs = profileBindingEvidence.evidenceRefs;
const sourceFirstProfileBinding =
  GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS.validationProfileEvidenceBindingFacet(
    profileBindingRow,
    profileBindingEvidence,
  );
assert.equal(sourceFirstProfileBinding.accepted, true);
assert.equal(sourceFirstProfileBinding.sourceFirstProfileIdBoundToRow, true);
assert.equal(sourceFirstProfileBinding.profileIdBoundToRow, true);

const fixtureSourceProfileBinding =
  GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS.validationProfileEvidenceBindingFacet(
    profileBindingRow,
    {
      ...profileBindingEvidence,
      source: 'agent_split_fixture_runtime_visual_proof',
    },
  );
assert.equal(fixtureSourceProfileBinding.accepted, true);
assert.equal(fixtureSourceProfileBinding.sourceFirstProfileIdBoundToRow, true);
assert.equal(fixtureSourceProfileBinding.profileIdBoundToRow, true);

const retargetedProfileBinding =
  GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS.validationProfileEvidenceBindingFacet(
    {
      ...profileBindingRow,
      sourceFirstIngestion: {
        accepted: true,
        targetId: 'generated-gpu-split:other-alias',
      },
    },
    profileBindingEvidence,
  );
assert.equal(retargetedProfileBinding.accepted, false);
assert.ok(retargetedProfileBinding.failedGates.includes(
  'validation_profile_id_not_bound_to_runtime_identity',
));

console.log('gpu-hmr visual semantic probes smoke ok');
