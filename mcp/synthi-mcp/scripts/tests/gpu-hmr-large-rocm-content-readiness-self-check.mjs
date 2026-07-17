#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';

const {
  largeRocmMlRandomColdContentAddressedSupportEvidence,
  largeRocmMlRandomColdPathIndependentContentIdentityHashes,
} = GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS;

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function gitObject(value) {
  return createHash('sha1').update(String(value)).digest('hex');
}

const runtimeClosureGateKeys = [
  'cold_source_intake',
  'cold_build_execution',
  'runtime_adapter_or_app_hook_contract',
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_or_visual_oracle',
  'cpu_gpu_firewall',
  'same_process_runtime_oracle',
  'runtime_chain',
  'strict_runtime_ledger',
];

function supportFixture({
  pathPrefix = 'ordinary/tree-a',
  sourceBytes = 'device translation unit bytes v1',
  buildBytes = 'typed build graph bytes v1',
  backendSignals = [{ backend: 'hip_rocm', reason: 'typed_compiler_language' }],
  immutableCommit = gitObject('exact immutable commit v1'),
  runtimeClosure = {},
  labels = {},
} = {}) {
  const sourceObject = gitObject(sourceBytes);
  const buildObject = gitObject(buildBytes);
  const sourcePath = `${pathPrefix}/unit.code`;
  const buildPath = `${pathPrefix}/graph.build`;
  const entries = [
    {
      path: sourcePath,
      object: sourceObject,
      byteLength: Buffer.byteLength(sourceBytes),
    },
    {
      path: buildPath,
      object: buildObject,
      byteLength: Buffer.byteLength(buildBytes),
    },
  ];
  const sourceListingHash = sha256(JSON.stringify(entries));
  const buildFile = {
    path: buildPath,
    object: buildObject,
    declaredByteLength: Buffer.byteLength(buildBytes),
    contentHash: sha256(buildBytes),
    semanticSummary: {
      backendSignalAuthority: 'build_metadata_semantic_tokens_only_not_runtime_authority',
      backendSignals,
    },
  };
  return largeRocmMlRandomColdContentAddressedSupportEvidence({
    immutableCommit,
    sourceIdentityHash: sha256(`source:${immutableCommit}`),
    sourceContentIdentityHash: sha256(`content:${immutableCommit}:${sourceListingHash}`),
    sourceListingManifest: {
      acceptedAsSourceListingEvidence: true,
      sourceListingHash,
      recomputedSourceListingHash: sourceListingHash,
      entries,
    },
    buildContentEvidence: {
      acceptedAsBuildMetadataContent: true,
      contentEvidenceHash: sha256(JSON.stringify(buildFile)),
      recomputedContentEvidenceHash: sha256(JSON.stringify(buildFile)),
      buildFiles: [buildFile],
    },
    sourceEvidenceProvenance: {
      accepted: true,
      evidenceMode: 'full_raw_source_listing_and_build_content',
    },
    runtimeClosure,
    ...labels,
  });
}

const ordinarySupport = supportFixture();
assert.equal(ordinarySupport.accepted, true);
assert.equal(ordinarySupport.acceptedAsContentAddressedSupportEvidence, true);
assert.equal(ordinarySupport.compilerBuildSemanticBindingCount, 1);
assert.match(ordinarySupport.pathIndependentSourceBuildIdentityHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(ordinarySupport.pathTokensUsedForClassification, false);
assert.equal(ordinarySupport.domainVocabularyUsedForClassification, false);
assert.equal(ordinarySupport.acceptedForGpuHmr, false);
assert.equal(ordinarySupport.gpuHmrSuccess, false);
assert.equal(ordinarySupport.canSatisfyRuntimeProof, false);
assert.equal(ordinarySupport.canSatisfyDispatchProof, false);
assert.equal(ordinarySupport.strictRuntimeOracleClosureAccepted, false);

const renamedRetargets = [
  supportFixture({
    pathPrefix: 'renamed/attention-transformer-neural-a',
    labels: {
      targetId: 'attention-transformer-neural-target',
      profileId: 'large-ml-profile-label',
      fixtureId: 'gemm-diamond-fixture-label',
    },
  }),
  supportFixture({
    pathPrefix: 'renamed/completely-unrelated-b',
    labels: {
      targetId: 'different-target',
      profileId: 'different-profile',
      fixtureId: 'different-fixture',
    },
  }),
  supportFixture({
    pathPrefix: 'renamed/third-layout-c',
    immutableCommit: gitObject('retargeted commit with identical blobs'),
    labels: {
      projectName: 'neural-network-attention-transformer',
      targetName: 'rocm-gemm-training',
    },
  }),
];
assert.ok(renamedRetargets.every((evidence) => evidence.accepted === true));
assert.equal(
  largeRocmMlRandomColdPathIndependentContentIdentityHashes(renamedRetargets).length,
  1,
  'renaming or retargeting identical bytes must not inflate distinct-content readiness',
);
assert.notEqual(
  renamedRetargets[0].compilerBuildSemanticBindings[0].buildFilePathHash,
  renamedRetargets[1].compilerBuildSemanticBindings[0].buildFilePathHash,
  'the adversary must actually rename the build path',
);
assert.notEqual(
  renamedRetargets[0].contentAddressedBindingHash,
  renamedRetargets[1].contentAddressedBindingHash,
  'audit bindings retain exact source-manifest identity even when readiness deduplicates bytes',
);

const distinctContent = [
  supportFixture({ sourceBytes: 'ordinary source bytes distinct 1' }),
  supportFixture({ sourceBytes: 'ordinary source bytes distinct 2' }),
  supportFixture({ sourceBytes: 'ordinary source bytes distinct 3' }),
];
assert.equal(
  largeRocmMlRandomColdPathIndependentContentIdentityHashes(distinctContent).length,
  3,
  'genuinely different content-addressed trees must remain distinct',
);
assert.ok(distinctContent.every((evidence) => evidence.gpuHmrSuccess === false));

const labelOnly = supportFixture({
  pathPrefix: 'attention/transformer/neural/gemm',
  backendSignals: [],
  labels: {
    targetId: 'rocm-neural-network-training',
    profileId: 'attention-transformer-large-ml',
    fixtureId: 'gemm-softmax-convolution',
  },
});
assert.equal(labelOnly.accepted, false);
assert.ok(labelOnly.failedGates.includes(
  'large_rocm_ml_random_cold_source_intake_compiler_build_semantics_not_observed',
));

const wrongBackend = supportFixture({
  backendSignals: [{ backend: 'cuda', reason: 'typed_compiler_language' }],
});
assert.equal(wrongBackend.accepted, false);
assert.ok(wrongBackend.failedGates.includes(
  'large_rocm_ml_random_cold_source_intake_compiler_build_semantics_not_observed',
));

const mutableRevision = supportFixture({ immutableCommit: 'main' });
assert.equal(mutableRevision.accepted, false);
assert.ok(mutableRevision.failedGates.includes(
  'large_rocm_ml_random_cold_source_intake_exact_git_commit_missing',
));

const closedRuntime = supportFixture({
  runtimeClosure: {
    fullRuntimeAccepted: true,
    gateAccepted: Object.fromEntries(runtimeClosureGateKeys.map((key) => [key, true])),
  },
});
assert.equal(closedRuntime.strictRuntimeOracleClosureAccepted, true);
assert.equal(closedRuntime.acceptedForGpuHmr, false);
assert.equal(closedRuntime.gpuHmrSuccess, false);
assert.equal(closedRuntime.canSatisfyRuntimeProof, false);
assert.equal(closedRuntime.canSatisfyDispatchProof, false);

console.log('gpu-hmr large ROCm content readiness self-check ok');
