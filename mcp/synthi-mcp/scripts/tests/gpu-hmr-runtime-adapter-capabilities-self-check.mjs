#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  GPU_HMR_RUNTIME_ADAPTER_ARTIFACT_FORMATS,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_AUTHORITY,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_INTEGRITY_AUTHORITY,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_INTEGRITY_SCHEMA_VERSION,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_OBLIGATIONS,
  GPU_HMR_RUNTIME_ADAPTER_COMMAND_RECORDING_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REF_BYTES,
  GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REFS,
  GPU_HMR_RUNTIME_ADAPTER_OUTPUT_MODALITIES,
  GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS,
  GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OWNERS,
  GPU_HMR_RUNTIME_ADAPTER_PUBLICATION_MODELS,
  createGpuHmrRuntimeAdapterCapabilities,
  evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity,
} from '../lib/gpu-hmr-runtime-adapter-capabilities.mjs';
import {
  GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS,
  GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS,
} from '../lib/gpu-hmr-output-oracle-kind.mjs';

const OBLIGATION = GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_OBLIGATIONS;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROOF_ID_PATTERN = /^runtime-adapter-capabilities:sha256:[0-9a-f]{64}$/;
const facets = [];

function capabilityInput(overrides = {}) {
  const outputModality = overrides.outputModality ?? 'compute';
  return {
    artifactFormat: 'native_binary',
    outputModality,
    oracleKind: outputModality === 'visual'
      ? 'visual_frame_readback'
      : 'compute_readback',
    publicationModel: 'dispatch_table_epoch',
    commandRecordingModel: 'late_bound_dispatch',
    pipelineCacheOwner: 'adapter',
    evidenceRefs: ['evidence:oracle:primary', 'evidence:transport:primary'],
    ...overrides,
  };
}

function createFacet(overrides = {}) {
  const facet = createGpuHmrRuntimeAdapterCapabilities(capabilityInput(overrides));
  facets.push(facet);
  return facet;
}

function assertContains(actual, expected) {
  for (const value of expected) assert.ok(actual.includes(value), value);
}

function assertSupportOnly(facet) {
  assert.equal(facet.valid, true);
  assert.equal(facet.acceptedAsSupportEvidence, true);
  assert.equal(facet.acceptedForGpuHmr, false);
  assert.equal(facet.gpuHmrSuccess, false);
  assert.equal(facet.canSatisfyRuntimeProof, false);
  assert.equal(facet.canSatisfyDispatchProof, false);
}

assert.deepEqual([...GPU_HMR_RUNTIME_ADAPTER_ARTIFACT_FORMATS], [
  'native_binary',
  'portable_ir',
  'runtime_source',
  'engine_asset',
  'opaque_payload',
]);
assert.deepEqual([...GPU_HMR_RUNTIME_ADAPTER_OUTPUT_MODALITIES], [
  'compute',
  'visual',
]);
assert.deepEqual([...GPU_HMR_RUNTIME_ADAPTER_PUBLICATION_MODELS], [
  'dispatch_table_epoch',
  'pipeline_object_epoch',
  'engine_managed_epoch',
  'opaque_callback_epoch',
]);
assert.deepEqual([...GPU_HMR_RUNTIME_ADAPTER_COMMAND_RECORDING_MODELS], [
  'late_bound_dispatch',
  'record_after_publication',
  'pre_recorded_commands',
  'opaque_engine_managed',
]);
assert.deepEqual([...GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OWNERS], [
  'none',
  'adapter',
  'application',
  'runtime',
  'engine',
  'opaque_external',
]);
assert.deepEqual([...GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS], [
  'artifactFormat',
  'outputModality',
  'oracleKind',
  'publicationModel',
  'commandRecordingModel',
  'pipelineCacheOwner',
  'evidenceRefs',
]);

const alwaysRequired = [
  OBLIGATION.verifiedArtifactTransport,
  OBLIGATION.changedArtifactLoadIntoTargetProcess,
  OBLIGATION.epochPublication,
  OBLIGATION.loadedArtifactEpochBinding,
  OBLIGATION.postPublicationDispatch,
  OBLIGATION.dispatchEpochArtifactBinding,
  OBLIGATION.sameProcessHostIdentity,
  OBLIGATION.outputAfterDispatchOracleBinding,
  OBLIGATION.retirementSafety,
  OBLIGATION.abiCompatibility,
  OBLIGATION.cpuHmrFullRebuildRestartFirewall,
];
const computeRequired = [
  OBLIGATION.computeRawReadbackBytes,
  OBLIGATION.computeReadbackSchema,
  OBLIGATION.computeBeforeAfterChecksum,
  OBLIGATION.computeDeterministicSlice,
];
const visualRequired = [
  OBLIGATION.visualVerifiedBeforeBytes,
  OBLIGATION.visualVerifiedAfterBytes,
  OBLIGATION.visualVerifiedDiffBytes,
  OBLIGATION.visualDeterministicControls,
  OBLIGATION.visualPostEpochFrameBoundary,
  OBLIGATION.visualBlankFrameRejection,
  OBLIGATION.visualStaleFrameRejection,
  OBLIGATION.visualJitterRejection,
  OBLIGATION.visualTemporalEffectRejection,
];
const boundaryRequired = [
  OBLIGATION.explicitAppHookContract,
  OBLIGATION.runtimeBoundaryEvidence,
];
const recordAfterPublicationRequired = [
  OBLIGATION.postPublicationCommandRecording,
  OBLIGATION.newRecordingChangedArtifactProof,
];
const preRecordedRequired = [
  OBLIGATION.oldCommandInvalidation,
  OBLIGATION.oldCommandRetirement,
  OBLIGATION.postPublicationCommandRecording,
  OBLIGATION.postPublicationCommandRerecord,
  OBLIGATION.newRecordingChangedArtifactProof,
];

const baseline = createFacet();
const baselineIntegrity = evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity(baseline);
assert.equal(
  baselineIntegrity.schemaVersion,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_INTEGRITY_SCHEMA_VERSION,
);
assert.equal(
  baselineIntegrity.authority,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_INTEGRITY_AUTHORITY,
);
assert.equal(baselineIntegrity.valid, true);
assert.equal(baselineIntegrity.acceptedAsSupportEvidence, true);
assert.equal(baselineIntegrity.acceptedForGpuHmr, false);
assert.equal(baselineIntegrity.gpuHmrSuccess, false);
assert.equal(baselineIntegrity.canSatisfyRuntimeProof, false);
assert.equal(baselineIntegrity.canSatisfyDispatchProof, false);
assert.deepEqual(baselineIntegrity.failures, []);
assert.deepEqual(baselineIntegrity.recomputedFacet, baseline);

const serializedBaselineIntegrity = evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity(
  JSON.parse(JSON.stringify(baseline)),
);
assert.equal(serializedBaselineIntegrity.acceptedAsSupportEvidence, true);
assert.deepEqual(serializedBaselineIntegrity.recomputedFacet, baseline);
const reorderedSerializedBaseline = Object.fromEntries(
  Object.entries(JSON.parse(JSON.stringify(baseline))).reverse(),
);
assert.equal(
  evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity(reorderedSerializedBaseline)
    .acceptedAsSupportEvidence,
  true,
);

function assertFacetIntegrityRejected(candidate, expectedFailure) {
  const evaluation = evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity(candidate);
  assert.equal(evaluation.valid, false);
  assert.equal(evaluation.acceptedAsSupportEvidence, false);
  assert.equal(evaluation.acceptedForGpuHmr, false);
  assert.equal(evaluation.gpuHmrSuccess, false);
  assert.equal(evaluation.canSatisfyRuntimeProof, false);
  assert.equal(evaluation.canSatisfyDispatchProof, false);
  assert.equal(evaluation.recomputedFacet, null);
  assert.ok(evaluation.failures.includes(expectedFailure), JSON.stringify(evaluation));
}

const forgedSuccessFacet = JSON.parse(JSON.stringify(baseline));
forgedSuccessFacet.gpuHmrSuccess = true;
assertFacetIntegrityRejected(
  forgedSuccessFacet,
  'runtime_adapter_capabilities_facet_success_authority_forbidden',
);

const forgedCapabilitiesHashFacet = JSON.parse(JSON.stringify(baseline));
forgedCapabilitiesHashFacet.capabilitiesHash = `sha256:${'0'.repeat(64)}`;
assertFacetIntegrityRejected(
  forgedCapabilitiesHashFacet,
  'runtime_adapter_capabilities_facet_capabilitiesHash_mismatch',
);

for (const [field, value] of [
  ['obligationsHash', `sha256:${'1'.repeat(64)}`],
  ['bindingHash', `sha256:${'2'.repeat(64)}`],
  ['proofId', `runtime-adapter-capabilities:sha256:${'3'.repeat(64)}`],
]) {
  const forgedFacet = JSON.parse(JSON.stringify(baseline));
  forgedFacet[field] = value;
  assertFacetIntegrityRejected(
    forgedFacet,
    `runtime_adapter_capabilities_facet_${field}_mismatch`,
  );
}

const missingObligationFacet = JSON.parse(JSON.stringify(baseline));
missingObligationFacet.obligations.pop();
assertFacetIntegrityRejected(
  missingObligationFacet,
  'runtime_adapter_capabilities_facet_obligations_mismatch',
);

for (const identityField of ['backend', 'project', 'profile', 'target', 'fixture']) {
  const identityFacet = JSON.parse(JSON.stringify(baseline));
  identityFacet[identityField] = `identity:${identityField}`;
  assertFacetIntegrityRejected(
    identityFacet,
    'runtime_adapter_capabilities_facet_field_set_mismatch',
  );
}

assertFacetIntegrityRejected(
  new Proxy(JSON.parse(JSON.stringify(baseline)), {}),
  'runtime_adapter_capabilities_facet_plain_data_proxy',
);

const nestedProxyFacet = JSON.parse(JSON.stringify(baseline));
nestedProxyFacet.evidenceRefs = new Proxy(nestedProxyFacet.evidenceRefs, {});
assertFacetIntegrityRejected(
  nestedProxyFacet,
  'runtime_adapter_capabilities_facet_plain_data_proxy',
);

const cyclicFacet = JSON.parse(JSON.stringify(baseline));
cyclicFacet.evidenceRefs.push(cyclicFacet);
assertFacetIntegrityRejected(
  cyclicFacet,
  'runtime_adapter_capabilities_facet_plain_data_cycle',
);

const topLevelAccessorFacet = JSON.parse(JSON.stringify(baseline));
let topLevelAccessorCalled = false;
Object.defineProperty(topLevelAccessorFacet, 'schemaVersion', {
  enumerable: true,
  configurable: true,
  get() {
    topLevelAccessorCalled = true;
    return GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION;
  },
});
assertFacetIntegrityRejected(
  topLevelAccessorFacet,
  'runtime_adapter_capabilities_facet_plain_data_accessor_property',
);
assert.equal(topLevelAccessorCalled, false);

const nestedAccessorFacet = JSON.parse(JSON.stringify(baseline));
let nestedAccessorCalled = false;
Object.defineProperty(nestedAccessorFacet.evidenceRefs, '0', {
  enumerable: true,
  configurable: true,
  get() {
    nestedAccessorCalled = true;
    return 'evidence:oracle:primary';
  },
});
assertFacetIntegrityRejected(
  nestedAccessorFacet,
  'runtime_adapter_capabilities_facet_plain_data_array_accessor',
);
assert.equal(nestedAccessorCalled, false);
assert.equal(
  baseline.schemaVersion,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
);
assert.equal(baseline.authority, GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_AUTHORITY);
assert.match(baseline.capabilitiesHash, HASH_PATTERN);
assert.match(baseline.obligationsHash, HASH_PATTERN);
assert.match(baseline.bindingHash, HASH_PATTERN);
assert.match(baseline.proofId, PROOF_ID_PATTERN);
assert.deepEqual(baseline.obligations, [
  ...alwaysRequired,
  ...computeRequired,
  ...GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS.adapter,
]);
assert.equal(new Set(baseline.obligations).size, baseline.obligations.length);
assert.equal(Object.isFrozen(baseline), true);
assert.equal(Object.isFrozen(baseline.evidenceRefs), true);
assert.equal(Object.isFrozen(baseline.obligations), true);
assert.throws(() => {
  baseline.acceptedForGpuHmr = true;
}, TypeError);

const reorderedInput = {
  evidenceRefs: ['evidence:transport:primary', 'evidence:oracle:primary'],
  pipelineCacheOwner: 'adapter',
  commandRecordingModel: 'late_bound_dispatch',
  publicationModel: 'dispatch_table_epoch',
  oracleKind: 'compute_readback',
  outputModality: 'compute',
  artifactFormat: 'native_binary',
};
const reorderedFacet = createGpuHmrRuntimeAdapterCapabilities(reorderedInput);
facets.push(reorderedFacet);
assert.deepEqual(reorderedFacet, baseline);
assert.equal(reorderedFacet.capabilitiesHash, baseline.capabilitiesHash);
assert.equal(reorderedFacet.obligationsHash, baseline.obligationsHash);
assert.equal(reorderedFacet.bindingHash, baseline.bindingHash);
assert.equal(reorderedFacet.proofId, baseline.proofId);

const wrappers = [
  {
    metadata: { callerName: 'hypothetical-caller-alpha' },
    dimensions: capabilityInput(),
  },
  {
    metadata: { callerName: 'hypothetical-caller-beta' },
    dimensions: reorderedInput,
  },
];
const wrappedFacets = wrappers.map(({ dimensions }) => {
  const facet = createGpuHmrRuntimeAdapterCapabilities(dimensions);
  facets.push(facet);
  return facet;
});
assert.deepEqual(wrappedFacets[0], wrappedFacets[1]);
for (const wrapper of wrappers) {
  assert.equal(
    JSON.stringify(wrappedFacets).includes(wrapper.metadata.callerName),
    false,
  );
}
assert.equal(GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS.includes('callerName'), false);

for (const artifactFormat of GPU_HMR_RUNTIME_ADAPTER_ARTIFACT_FORMATS) {
  const facet = createFacet({ artifactFormat });
  assert.equal(facet.artifactFormat, artifactFormat);
  assertContains(facet.obligations, alwaysRequired);
  if (artifactFormat === 'runtime_source') {
    assert.ok(facet.obligations.includes(
      OBLIGATION.runtimeCompilerSourceToArtifactProof,
    ));
  }
  if (artifactFormat === 'engine_asset' || artifactFormat === 'opaque_payload') {
    assertContains(facet.obligations, boundaryRequired);
  }
}

for (const outputModality of GPU_HMR_RUNTIME_ADAPTER_OUTPUT_MODALITIES) {
  const facet = createFacet({ outputModality });
  assert.equal(facet.outputModality, outputModality);
  assertContains(
    facet.obligations,
    outputModality === 'compute' ? computeRequired : visualRequired,
  );
}

for (const oracleKind of GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS) {
  const facet = createFacet({ oracleKind, outputModality: 'compute' });
  assert.equal(facet.oracleKind, oracleKind);
  assertContains(facet.obligations, computeRequired);
}
for (const oracleKind of GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS) {
  const facet = createFacet({ oracleKind, outputModality: 'visual' });
  assert.equal(facet.oracleKind, oracleKind);
  assertContains(facet.obligations, visualRequired);
}

for (const publicationModel of GPU_HMR_RUNTIME_ADAPTER_PUBLICATION_MODELS) {
  const facet = createFacet({ publicationModel });
  assert.equal(facet.publicationModel, publicationModel);
  if (publicationModel === 'pipeline_object_epoch') {
    assertContains(facet.obligations, [
      OBLIGATION.pipelineRecreation,
      OBLIGATION.pipelineIdentityEpochBinding,
    ]);
  }
  if (
    publicationModel === 'engine_managed_epoch'
    || publicationModel === 'opaque_callback_epoch'
  ) {
    assertContains(facet.obligations, boundaryRequired);
  }
}

for (const commandRecordingModel of GPU_HMR_RUNTIME_ADAPTER_COMMAND_RECORDING_MODELS) {
  const facet = createFacet({ commandRecordingModel });
  assert.equal(facet.commandRecordingModel, commandRecordingModel);
  if (commandRecordingModel === 'record_after_publication') {
    assertContains(facet.obligations, recordAfterPublicationRequired);
    assert.equal(facet.obligations.includes(OBLIGATION.oldCommandInvalidation), false);
    assert.equal(facet.obligations.includes(OBLIGATION.oldCommandRetirement), false);
    assert.equal(facet.obligations.includes(OBLIGATION.postPublicationCommandRerecord), false);
  }
  if (commandRecordingModel === 'pre_recorded_commands') {
    assertContains(facet.obligations, preRecordedRequired);
  }
  if (commandRecordingModel === 'opaque_engine_managed') {
    assertContains(facet.obligations, boundaryRequired);
  }
  if (
    commandRecordingModel === 'late_bound_dispatch'
    || commandRecordingModel === 'opaque_engine_managed'
  ) {
    assert.equal(
      facet.obligations.includes(OBLIGATION.postPublicationCommandRecording),
      false,
    );
    assert.equal(
      facet.obligations.includes(OBLIGATION.newRecordingChangedArtifactProof),
      false,
    );
  }
}

for (const pipelineCacheOwner of GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OWNERS) {
  const facet = createFacet({ pipelineCacheOwner });
  assert.equal(facet.pipelineCacheOwner, pipelineCacheOwner);
  assertContains(
    facet.obligations,
    GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS[pipelineCacheOwner],
  );
  if (['application', 'engine', 'opaque_external'].includes(pipelineCacheOwner)) {
    assertContains(facet.obligations, boundaryRequired);
  }
}

const visualFacet = createFacet({
  outputModality: 'visual',
  oracleKind: 'deterministic_framebuffer_diff',
});
assertContains(visualFacet.obligations, visualRequired);
for (const obligation of computeRequired) {
  assert.equal(visualFacet.obligations.includes(obligation), false, obligation);
}

const recordAfterPublicationFacet = createFacet({
  commandRecordingModel: 'record_after_publication',
});
assert.deepEqual(recordAfterPublicationFacet.obligations, [
  ...alwaysRequired,
  ...computeRequired,
  ...recordAfterPublicationRequired,
  ...GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS.adapter,
]);
assert.notEqual(recordAfterPublicationFacet.capabilitiesHash, baseline.capabilitiesHash);
assert.notEqual(recordAfterPublicationFacet.obligationsHash, baseline.obligationsHash);
assert.notEqual(recordAfterPublicationFacet.bindingHash, baseline.bindingHash);
assert.notEqual(recordAfterPublicationFacet.proofId, baseline.proofId);

const repeatedRecordAfterPublicationFacet = createFacet({
  commandRecordingModel: 'record_after_publication',
});
assert.equal(
  repeatedRecordAfterPublicationFacet.capabilitiesHash,
  recordAfterPublicationFacet.capabilitiesHash,
);
assert.equal(
  repeatedRecordAfterPublicationFacet.obligationsHash,
  recordAfterPublicationFacet.obligationsHash,
);
assert.equal(
  repeatedRecordAfterPublicationFacet.bindingHash,
  recordAfterPublicationFacet.bindingHash,
);
assert.equal(
  repeatedRecordAfterPublicationFacet.proofId,
  recordAfterPublicationFacet.proofId,
);

const preRecordedFacet = createFacet({
  commandRecordingModel: 'pre_recorded_commands',
});
assertContains(preRecordedFacet.obligations, preRecordedRequired);
assert.notEqual(preRecordedFacet.capabilitiesHash, baseline.capabilitiesHash);
assert.notEqual(preRecordedFacet.obligationsHash, baseline.obligationsHash);
assert.notEqual(preRecordedFacet.obligationsHash, recordAfterPublicationFacet.obligationsHash);
assert.notEqual(preRecordedFacet.bindingHash, recordAfterPublicationFacet.bindingHash);

const pipelineObjectFacet = createFacet({
  publicationModel: 'pipeline_object_epoch',
});
assertContains(pipelineObjectFacet.obligations, [
  OBLIGATION.pipelineRecreation,
  OBLIGATION.pipelineIdentityEpochBinding,
]);

const sourceFacet = createFacet({ artifactFormat: 'runtime_source' });
assert.ok(sourceFacet.obligations.includes(
  OBLIGATION.runtimeCompilerSourceToArtifactProof,
));

const managedBoundaryFacet = createFacet({
  artifactFormat: 'engine_asset',
  publicationModel: 'engine_managed_epoch',
  commandRecordingModel: 'opaque_engine_managed',
  pipelineCacheOwner: 'engine',
});
assertContains(managedBoundaryFacet.obligations, boundaryRequired);
assertContains(
  managedBoundaryFacet.obligations,
  GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS.engine,
);
assert.equal(
  managedBoundaryFacet.obligations.filter(
    (value) => value === OBLIGATION.explicitAppHookContract,
  ).length,
  1,
);

const opaqueBoundaryFacet = createFacet({
  artifactFormat: 'opaque_payload',
  publicationModel: 'opaque_callback_epoch',
  commandRecordingModel: 'opaque_engine_managed',
  pipelineCacheOwner: 'opaque_external',
});
assertContains(opaqueBoundaryFacet.obligations, boundaryRequired);
assertContains(
  opaqueBoundaryFacet.obligations,
  GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS.opaque_external,
);

const combinedOpaquePreRecordedPipelineFacet = createFacet({
  artifactFormat: 'opaque_payload',
  publicationModel: 'pipeline_object_epoch',
  commandRecordingModel: 'pre_recorded_commands',
  pipelineCacheOwner: 'opaque_external',
});
assert.deepEqual(combinedOpaquePreRecordedPipelineFacet.obligations, [
  ...alwaysRequired,
  ...boundaryRequired,
  ...computeRequired,
  OBLIGATION.pipelineRecreation,
  OBLIGATION.pipelineIdentityEpochBinding,
  ...preRecordedRequired,
  ...GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS.opaque_external,
]);
assertSupportOnly(combinedOpaquePreRecordedPipelineFacet);
assert.notEqual(
  combinedOpaquePreRecordedPipelineFacet.capabilitiesHash,
  opaqueBoundaryFacet.capabilitiesHash,
);
assert.notEqual(
  combinedOpaquePreRecordedPipelineFacet.obligationsHash,
  opaqueBoundaryFacet.obligationsHash,
);
assert.notEqual(
  combinedOpaquePreRecordedPipelineFacet.bindingHash,
  opaqueBoundaryFacet.bindingHash,
);

assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({
    outputModality: 'compute',
    oracleKind: 'visual_frame',
  })),
  /oracle_kind_modality_mismatch/,
);
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({
    outputModality: 'visual',
    oracleKind: 'buffer_checksum',
  })),
  /oracle_kind_modality_mismatch/,
);
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({
    oracleKind: 'unknown_oracle',
  })),
  /oracle_kind_invalid/,
);
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({
    oracleKind: ' COMPUTE_READBACK ',
  })),
  /oracle_kind_not_canonical/,
);

const hashVariants = [
  { artifactFormat: 'portable_ir' },
  { oracleKind: 'buffer_checksum' },
  { publicationModel: 'pipeline_object_epoch' },
  { commandRecordingModel: 'record_after_publication' },
  { pipelineCacheOwner: 'runtime' },
  { evidenceRefs: ['evidence:different'] },
  { outputModality: 'visual', oracleKind: 'visual_frame' },
];
for (const variant of hashVariants) {
  const facet = createFacet(variant);
  assert.notEqual(facet.capabilitiesHash, baseline.capabilitiesHash);
  assert.notEqual(facet.bindingHash, baseline.bindingHash);
  assert.notEqual(facet.proofId, baseline.proofId);
}

const differentEvidence = createFacet({
  evidenceRefs: ['evidence:alternate:one', 'evidence:alternate:two'],
});
assert.deepEqual(differentEvidence.obligations, baseline.obligations);
assert.equal(differentEvidence.obligationsHash, baseline.obligationsHash);
assert.notEqual(differentEvidence.capabilitiesHash, baseline.capabilitiesHash);

for (const field of GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS) {
  const missing = capabilityInput();
  delete missing[field];
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilities(missing),
    /input_missing_field/,
    field,
  );
}

for (const [field, value] of [
  ['artifactFormat', 'invalid_artifact'],
  ['outputModality', 'invalid_modality'],
  ['publicationModel', 'invalid_publication'],
  ['commandRecordingModel', 'invalid_recording'],
  ['pipelineCacheOwner', 'invalid_owner'],
]) {
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({ [field]: value })),
    /_invalid/,
    field,
  );
}

const unknownFields = [
  'extra',
  'schemaVersion',
  'authority',
  'proofAuthority',
  'valid',
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'obligations',
  'capabilitiesHash',
  'bindingHash',
  'proofId',
  'callerName',
];
for (const field of unknownFields) {
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilities({
      ...capabilityInput(),
      [field]: field === 'gpuHmrSuccess' ? true : 'not-contract-input',
    }),
    /input_unknown_field/,
    field,
  );
}

const identityTerms = ['backend', 'project', 'target', 'profile', 'fixture'];
for (const field of identityTerms) {
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilities({
      ...capabilityInput(),
      [field]: `identity-value-${field}`,
    }),
    /input_unknown_field/,
    field,
  );
}

let inputProxyTrapCalled = false;
const proxiedInput = new Proxy(capabilityInput(), {
  ownKeys() {
    inputProxyTrapCalled = true;
    throw new Error('proxy trap must not run');
  },
});
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(proxiedInput),
  /input_proxy_forbidden/,
);
assert.equal(inputProxyTrapCalled, false);

let inputGetterCalled = false;
const accessorInput = capabilityInput();
Object.defineProperty(accessorInput, 'artifactFormat', {
  configurable: true,
  enumerable: true,
  get() {
    inputGetterCalled = true;
    return 'native_binary';
  },
});
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(accessorInput),
  /input_accessor_forbidden/,
);
assert.equal(inputGetterCalled, false);

let unknownGetterCalled = false;
const unknownAccessorInput = capabilityInput();
Object.defineProperty(unknownAccessorInput, 'unknown', {
  configurable: true,
  enumerable: true,
  get() {
    unknownGetterCalled = true;
    return 'unknown';
  },
});
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(unknownAccessorInput),
  /input_accessor_forbidden/,
);
assert.equal(unknownGetterCalled, false);

const nonPlainInput = Object.assign(Object.create(null), capabilityInput());
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(nonPlainInput),
  /input_must_be_plain_data_record/,
);

let refsProxyTrapCalled = false;
const proxiedRefs = new Proxy(['evidence:one'], {
  getOwnPropertyDescriptor() {
    refsProxyTrapCalled = true;
    throw new Error('proxy trap must not run');
  },
});
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({
    evidenceRefs: proxiedRefs,
  })),
  /evidence_refs_proxy_forbidden/,
);
assert.equal(refsProxyTrapCalled, false);

let refsGetterCalled = false;
const accessorRefs = ['evidence:placeholder'];
Object.defineProperty(accessorRefs, '0', {
  configurable: true,
  enumerable: true,
  get() {
    refsGetterCalled = true;
    return 'evidence:one';
  },
});
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({
    evidenceRefs: accessorRefs,
  })),
  /evidence_refs_accessor_forbidden/,
);
assert.equal(refsGetterCalled, false);

const sparseRefs = new Array(1);
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({
    evidenceRefs: sparseRefs,
  })),
  /evidence_refs_sparse_or_non_enumerable/,
);
const refsWithExtraProperty = ['evidence:one'];
refsWithExtraProperty.extra = 'forbidden';
assert.throws(
  () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({
    evidenceRefs: refsWithExtraProperty,
  })),
  /evidence_refs_extra_property_forbidden/,
);

for (const invalidEvidenceRefs of [
  [],
  [''],
  [' evidence:one'],
  [42],
  [{}],
  ['evidence:duplicate', 'evidence:duplicate'],
  ['x'.repeat(GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REF_BYTES + 1)],
  Array.from(
    { length: GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REFS + 1 },
    (_, index) => `evidence:${index}`,
  ),
]) {
  assert.throws(
    () => createGpuHmrRuntimeAdapterCapabilities(capabilityInput({
      evidenceRefs: invalidEvidenceRefs,
    })),
    /evidence_ref|evidence_refs/,
  );
}

function splitIdentifier(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function assertNoIdentityLeak(value, forbiddenValues, seen = new Set()) {
  if (typeof value === 'string') {
    for (const forbiddenValue of forbiddenValues) {
      assert.equal(value.includes(forbiddenValue), false, value);
    }
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => assertNoIdentityLeak(entry, forbiddenValues, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const keyTokens = splitIdentifier(key);
    for (const term of identityTerms) assert.equal(keyTokens.includes(term), false, key);
    assertNoIdentityLeak(entry, forbiddenValues, seen);
  }
}

const callerNames = wrappers.map((wrapper) => wrapper.metadata.callerName);
const forbiddenIdentityValues = [
  ...callerNames,
  ...identityTerms.map((term) => `identity-value-${term}`),
];
for (const facet of facets) {
  assertSupportOnly(facet);
  assertContains(facet.obligations, alwaysRequired);
  assert.equal(new Set(facet.obligations).size, facet.obligations.length);
  assertNoIdentityLeak(facet, forbiddenIdentityValues);
}

process.stdout.write(`${JSON.stringify({
  status: 'self_check_passed',
  schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
  checkedFacets: facets.length,
  deterministicProofId: baseline.proofId,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  canSatisfyRuntimeProof: false,
  canSatisfyDispatchProof: false,
}, null, 2)}\n`);
