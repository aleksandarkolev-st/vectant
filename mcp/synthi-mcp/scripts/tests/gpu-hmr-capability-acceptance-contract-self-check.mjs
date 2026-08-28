#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_AUTHORITY,
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_FIELDS,
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INPUT_FIELDS,
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INTEGRITY_AUTHORITY,
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INTEGRITY_SCHEMA_VERSION,
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SUBJECT_FIELDS,
  GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_ARRAY_LENGTH,
  createGpuHmrCapabilityAcceptanceContract,
  declareGpuHmrCapabilityAcceptanceContract,
  evaluateGpuHmrCapabilityAcceptanceContractIntegrity,
} from '../lib/gpu-hmr-capability-acceptance-contract.mjs';
import {
  createGpuHmrRuntimeAdapterCapabilities,
} from '../lib/gpu-hmr-runtime-adapter-capabilities.mjs';
import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2,
  GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_FORMATS,
  GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_MATERIALIZATION_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_COMMAND_RECORDING_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_DEVICE_TOPOLOGIES,
  GPU_HMR_RUNTIME_ADAPTER_V2_DISPATCH_BINDING_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_ORACLE_KINDS,
  GPU_HMR_RUNTIME_ADAPTER_V2_OUTPUT_MODALITIES,
  GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_CACHE_OWNERS,
  GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_REUSE_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_PUBLICATION_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_RAY_TRACING_STATE_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_RESOURCE_BINDING_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_STATE_CONTINUITY_MODELS,
  GPU_HMR_RUNTIME_ADAPTER_V2_SYNCHRONIZATION_TOPOLOGIES,
  createGpuHmrRuntimeAdapterCapabilitiesV2,
  deriveGpuHmrRuntimeAdapterCapabilityObligationsV2,
} from '../lib/gpu-hmr-runtime-adapter-capabilities-v2.mjs';
import {
  classifyGpuHmrOutputOracleKind,
} from '../lib/gpu-hmr-output-oracle-kind.mjs';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROOF_ID_PATTERN =
  /^gpu-hmr-capability-acceptance-contract:sha256:[0-9a-f]{64}$/;
const IDENTITY_FIELDS = Object.freeze([
  'project',
  'projectName',
  'target',
  'targetName',
  'backend',
  'backendName',
  'profile',
  'profileName',
  'fixture',
  'fixtureName',
  'library',
  'libraryName',
  'family',
  'familyName',
  'scenario',
  'scenarioName',
]);
const CALLER_AUTHORITY_FIELDS = Object.freeze([
  'obligations',
  'evidence',
  'gpuHmrEvidence',
  'verifierEvidence',
  'projection',
  'verifierOutcomes',
  'evidenceOutcomes',
  'outcomes',
  'authority',
  'valid',
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function hash(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function randomHash() {
  return `sha256:${randomBytes(32).toString('hex')}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function shuffledClone(value) {
  if (Array.isArray(value)) return value.map((entry) => shuffledClone(entry));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([key, entry]) => [key, shuffledClone(entry)],
    );
    for (let index = entries.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1);
      [entries[index], entries[swapIndex]] = [entries[swapIndex], entries[index]];
    }
    return Object.fromEntries(entries);
  }
  return value;
}

function subjectBinding(seed = 'baseline') {
  return {
    sourceManifestHash: hash(`${seed}:source-manifest`),
    editHash: hash(`${seed}:edit`),
    artifactBeforeHash: hash(`${seed}:artifact-before`),
    artifactAfterHash: hash(`${seed}:artifact-after`),
  };
}

function capabilityFacet(overrides = {}) {
  const classifiedOracle = overrides.oracleKind
    ? classifyGpuHmrOutputOracleKind(overrides.oracleKind)
    : null;
  const outputModality = overrides.outputModality
    ?? classifiedOracle?.modality
    ?? 'compute';
  const pipelineCacheOwner = overrides.pipelineCacheOwner ?? (
    ['cache', 'cache_and_library'].includes(overrides.pipelineReuseModel)
      ? 'adapter'
      : 'none'
  );
  const pipelineReuseModel = overrides.pipelineReuseModel ?? (
    pipelineCacheOwner === 'none' ? 'none' : 'cache'
  );
  return createGpuHmrRuntimeAdapterCapabilitiesV2({
    artifactFormat: 'native_binary',
    outputModality,
    oracleKind: outputModality === 'visual'
      ? 'visual_frame_readback'
      : 'compute_readback',
    publicationModel: 'dispatch_table_epoch',
    commandRecordingModel: 'late_bound_dispatch',
    pipelineCacheOwner,
    artifactMaterializationModel: 'ahead_of_time',
    dispatchBindingModel: 'direct',
    resourceBindingModel: 'fixed_layout',
    deviceTopology: 'single_device',
    synchronizationTopology: 'single_queue_ordered',
    stateContinuityModel: 'stateless',
    rayTracingStateModel: 'none',
    pipelineReuseModel,
    evidenceRefs: ['capability-declaration:self-check'],
    ...overrides,
    outputModality,
    pipelineCacheOwner,
    pipelineReuseModel,
  });
}

function input(overrides = {}) {
  return {
    subjectBinding: subjectBinding(),
    capabilityFacet: clone(capabilityFacet()),
    ...overrides,
  };
}

function factsFromFacet(facet) {
  return Object.fromEntries(
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2.map(
      (field) => [field, facet[field]],
    ),
  );
}

const CAPABILITY_DIMENSIONS = Object.freeze([
  ['artifactFormat', GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_FORMATS],
  ['outputModality', GPU_HMR_RUNTIME_ADAPTER_V2_OUTPUT_MODALITIES],
  ['publicationModel', GPU_HMR_RUNTIME_ADAPTER_V2_PUBLICATION_MODELS],
  ['commandRecordingModel', GPU_HMR_RUNTIME_ADAPTER_V2_COMMAND_RECORDING_MODELS],
  ['pipelineCacheOwner', GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_CACHE_OWNERS],
  [
    'artifactMaterializationModel',
    GPU_HMR_RUNTIME_ADAPTER_V2_ARTIFACT_MATERIALIZATION_MODELS,
  ],
  ['dispatchBindingModel', GPU_HMR_RUNTIME_ADAPTER_V2_DISPATCH_BINDING_MODELS],
  ['resourceBindingModel', GPU_HMR_RUNTIME_ADAPTER_V2_RESOURCE_BINDING_MODELS],
  ['deviceTopology', GPU_HMR_RUNTIME_ADAPTER_V2_DEVICE_TOPOLOGIES],
  [
    'synchronizationTopology',
    GPU_HMR_RUNTIME_ADAPTER_V2_SYNCHRONIZATION_TOPOLOGIES,
  ],
  ['stateContinuityModel', GPU_HMR_RUNTIME_ADAPTER_V2_STATE_CONTINUITY_MODELS],
  ['rayTracingStateModel', GPU_HMR_RUNTIME_ADAPTER_V2_RAY_TRACING_STATE_MODELS],
  ['pipelineReuseModel', GPU_HMR_RUNTIME_ADAPTER_V2_PIPELINE_REUSE_MODELS],
]);

function assertDeclarationOnly(value) {
  assert.equal(value.valid, true);
  assert.equal(value.acceptedAsSupportEvidence, false);
  assert.equal(value.acceptedForGpuHmr, false);
  assert.equal(value.gpuHmrSuccess, false);
  assert.equal(value.canSatisfyRuntimeProof, false);
  assert.equal(value.canSatisfyDispatchProof, false);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function assertCreateRejected(candidate, pattern = /gpu_hmr_capability_acceptance_contract/) {
  assert.throws(
    () => createGpuHmrCapabilityAcceptanceContract(candidate),
    pattern,
  );
}

function assertIntegrityRejected(candidate) {
  const integrity = evaluateGpuHmrCapabilityAcceptanceContractIntegrity(candidate);
  assert.equal(integrity.valid, false, JSON.stringify(integrity));
  assert.equal(integrity.acceptedAsSupportEvidence, false);
  assert.equal(integrity.acceptedForGpuHmr, false);
  assert.equal(integrity.gpuHmrSuccess, false);
  assert.equal(integrity.canSatisfyRuntimeProof, false);
  assert.equal(integrity.canSatisfyDispatchProof, false);
  assert.equal(integrity.recomputedContract, null);
  assert.ok(integrity.failures.length > 0);
  assertDeepFrozen(integrity);
}

assert.equal(
  declareGpuHmrCapabilityAcceptanceContract,
  createGpuHmrCapabilityAcceptanceContract,
);
assert.deepEqual([...GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INPUT_FIELDS], [
  'subjectBinding',
  'capabilityFacet',
]);
assert.deepEqual([...GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SUBJECT_FIELDS], [
  'sourceManifestHash',
  'editHash',
  'artifactBeforeHash',
  'artifactAfterHash',
]);
assert.match(GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_AUTHORITY, /declaration_only/);
assert.match(GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_AUTHORITY, /not_evidence/);
assert.match(GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_AUTHORITY, /runtime/);
assert.match(GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_AUTHORITY, /dispatch/);
assert.match(GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_AUTHORITY, /gpu_hmr_acceptance/);
assert.match(GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SCHEMA_VERSION, /\.v2$/);
assert.match(
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INTEGRITY_SCHEMA_VERSION,
  /\.v2$/,
);

const baselineInput = input();
const baseline = createGpuHmrCapabilityAcceptanceContract(baselineInput);
assert.equal(baseline.schemaVersion, GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SCHEMA_VERSION);
assert.equal(baseline.authority, GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_AUTHORITY);
assert.deepEqual(Object.keys(baseline), GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_FIELDS);
assert.deepEqual(baseline.subjectBinding, baselineInput.subjectBinding);
assert.deepEqual(baseline.capabilityFacet, baselineInput.capabilityFacet);
assert.equal(
  baseline.capabilityFacet.schemaVersion,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
);
assert.equal(baseline.capabilityBindingHash, baseline.capabilityFacet.bindingHash);
assert.deepEqual(
  baseline.obligations,
  deriveGpuHmrRuntimeAdapterCapabilityObligationsV2(
    factsFromFacet(baseline.capabilityFacet),
  ),
);
assert.match(baseline.subjectBindingHash, SHA256_PATTERN);
assert.match(baseline.contractHash, SHA256_PATTERN);
assert.match(baseline.proofId, PROOF_ID_PATTERN);
assertDeclarationOnly(baseline);
assertDeepFrozen(baseline);

const historicalCapabilityFacet = createGpuHmrRuntimeAdapterCapabilities({
  artifactFormat: 'native_binary',
  outputModality: 'compute',
  oracleKind: 'compute_readback',
  publicationModel: 'dispatch_table_epoch',
  commandRecordingModel: 'late_bound_dispatch',
  pipelineCacheOwner: 'adapter',
  evidenceRefs: ['historical-capability:self-check'],
});
assertCreateRejected(
  {
    subjectBinding: subjectBinding('historical-v1'),
    capabilityFacet: clone(historicalCapabilityFacet),
  },
  /capability_facet_current_version_required/,
);
const mixedVersionCapabilityFacet = clone(historicalCapabilityFacet);
mixedVersionCapabilityFacet.artifactMaterializationModel = 'ahead_of_time';
assertCreateRejected({
  subjectBinding: subjectBinding('mixed-version'),
  capabilityFacet: mixedVersionCapabilityFacet,
});
const legacyShapeWithV2Version = clone(historicalCapabilityFacet);
legacyShapeWithV2Version.schemaVersion =
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION;
assertCreateRejected({
  subjectBinding: subjectBinding('v2-version-legacy-shape'),
  capabilityFacet: legacyShapeWithV2Version,
});
const duplicateVersionAliasFacet = clone(baselineInput.capabilityFacet);
duplicateVersionAliasFacet.schema_version = duplicateVersionAliasFacet.schemaVersion;
assertCreateRejected({
  subjectBinding: subjectBinding('duplicate-version-alias'),
  capabilityFacet: duplicateVersionAliasFacet,
});

assert.equal(
  baseline.subjectBindingHash,
  canonicalSha256({
    domain: `${GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SCHEMA_VERSION}.subject_binding`,
    subjectBinding: baseline.subjectBinding,
  }),
);
const baselineContractMaterial = Object.fromEntries([
  'schemaVersion',
  'authority',
  'subjectBinding',
  'subjectBindingHash',
  'capabilityFacet',
  'capabilityBindingHash',
  'obligations',
  'valid',
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
].map((field) => [field, baseline[field]]));
assert.equal(
  baseline.contractHash,
  canonicalSha256({
    domain: `${GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SCHEMA_VERSION}.contract`,
    contract: baselineContractMaterial,
  }),
);
assert.equal(
  baseline.proofId,
  `gpu-hmr-capability-acceptance-contract:${baseline.contractHash}`,
);

const serializedIntegrity = evaluateGpuHmrCapabilityAcceptanceContractIntegrity(
  clone(baseline),
);
assert.equal(
  serializedIntegrity.schemaVersion,
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INTEGRITY_SCHEMA_VERSION,
);
assert.equal(
  serializedIntegrity.authority,
  GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INTEGRITY_AUTHORITY,
);
assertDeclarationOnly(serializedIntegrity);
assert.deepEqual(serializedIntegrity.failures, []);
assert.deepEqual(serializedIntegrity.recomputedContract, baseline);
assertDeclarationOnly(serializedIntegrity.recomputedContract);
assertDeepFrozen(serializedIntegrity);

let capabilityCombinations = 0;
const combinationContractHashes = new Set();
const combinationCapabilityHashes = new Set();
const assertCapabilityContract = (facet) => {
  const contract = createGpuHmrCapabilityAcceptanceContract({
    subjectBinding: subjectBinding('capability-dimensions'),
    capabilityFacet: clone(facet),
  });
  const expected = deriveGpuHmrRuntimeAdapterCapabilityObligationsV2(
    factsFromFacet(facet),
  );
  assert.deepEqual(contract.obligations, expected);
  assert.equal(contract.capabilityBindingHash, facet.bindingHash);
  assertDeclarationOnly(contract);
  assert.equal(
    evaluateGpuHmrCapabilityAcceptanceContractIntegrity(clone(contract)).valid,
    true,
  );
  combinationCapabilityHashes.add(facet.bindingHash);
  combinationContractHashes.add(contract.contractHash);
  capabilityCombinations += 1;
};

for (const [field, values] of CAPABILITY_DIMENSIONS) {
  for (const value of values) {
    const overrides = { [field]: value };
    if (field === 'outputModality') {
      overrides.oracleKind = value === 'visual'
        ? 'visual_frame_readback'
        : 'compute_readback';
    }
    assertCapabilityContract(capabilityFacet(overrides));
  }
}
for (const oracleKind of GPU_HMR_RUNTIME_ADAPTER_V2_ORACLE_KINDS) {
  const classification = classifyGpuHmrOutputOracleKind(oracleKind);
  assert.equal(classification.accepted, true);
  assertCapabilityContract(capabilityFacet({
    oracleKind,
    outputModality: classification.modality,
  }));
}
assert.equal(
  combinationContractHashes.size,
  combinationCapabilityHashes.size,
);
assert.ok(combinationCapabilityHashes.size > CAPABILITY_DIMENSIONS.length);

for (const { overrides, requiredObligations } of [
  {
    overrides: { outputModality: 'visual', oracleKind: 'visual_frame_readback' },
    requiredObligations: [
      'visual_verified_after_bytes',
      'visual_post_epoch_frame_boundary',
      'visual_oracle_dispatch_epoch_artifact_binding',
    ],
  },
  {
    overrides: { artifactFormat: 'execution_graph', dispatchBindingModel: 'captured_graph' },
    requiredObligations: [
      'graph_new_artifact_binding',
      'graph_executable_epoch_binding',
      'graph_old_executable_retirement',
    ],
  },
  {
    overrides: { commandRecordingModel: 'pre_recorded_commands' },
    requiredObligations: [
      'old_command_invalidation',
      'post_publication_command_rerecord',
      'new_recording_changed_artifact_proof',
    ],
  },
  {
    overrides: {
      deviceTopology: 'multi_device',
      synchronizationTopology: 'multi_device',
    },
    requiredObligations: [
      'multi_device_membership_binding',
      'per_participant_output_binding',
      'multi_device_retirement_fence',
    ],
  },
  {
    overrides: {
      artifactFormat: 'opaque_payload',
      publicationModel: 'opaque_callback_epoch',
      artifactMaterializationModel: 'opaque',
      dispatchBindingModel: 'opaque',
      resourceBindingModel: 'opaque',
    },
    requiredObligations: [
      'explicit_app_hook_contract',
      'runtime_boundary_evidence',
      'opaque_payload_explicit_app_hook_contract',
    ],
  },
  {
    overrides: { rayTracingStateModel: 'acceleration_structures_and_shader_tables' },
    requiredObligations: [
      'acceleration_structure_identity_epoch_binding',
      'shader_table_identity_epoch_binding',
      'acceleration_structure_shader_table_dependency_ordering',
    ],
  },
]) {
  const contract = createGpuHmrCapabilityAcceptanceContract({
    subjectBinding: subjectBinding('obligation-sentinels'),
    capabilityFacet: clone(capabilityFacet(overrides)),
  });
  for (const obligation of requiredObligations) {
    assert.ok(contract.obligations.includes(obligation), obligation);
  }
}

const randomContractHashes = new Set();
for (let iteration = 0; iteration < 64; iteration += 1) {
  const randomSubject = {
    sourceManifestHash: randomHash(),
    editHash: randomHash(),
    artifactBeforeHash: randomHash(),
    artifactAfterHash: randomHash(),
  };
  if (randomSubject.artifactBeforeHash === randomSubject.artifactAfterHash) {
    randomSubject.artifactAfterHash = hash(`forced-after:${iteration}`);
  }
  const oracleKind = GPU_HMR_RUNTIME_ADAPTER_V2_ORACLE_KINDS[
    iteration % GPU_HMR_RUNTIME_ADAPTER_V2_ORACLE_KINDS.length
  ];
  const oracleClassification = classifyGpuHmrOutputOracleKind(oracleKind);
  const capabilityOverrides = {
    oracleKind,
    outputModality: oracleClassification.modality,
  };
  for (const [field, values] of CAPABILITY_DIMENSIONS) {
    if (field === 'outputModality') continue;
    capabilityOverrides[field] = values[iteration % values.length];
  }
  if (capabilityOverrides.pipelineReuseModel === 'none') {
    capabilityOverrides.pipelineCacheOwner = 'none';
  } else if (
    ['cache', 'cache_and_library'].includes(capabilityOverrides.pipelineReuseModel)
    && capabilityOverrides.pipelineCacheOwner === 'none'
  ) {
    capabilityOverrides.pipelineCacheOwner = 'adapter';
  }
  const ordered = {
    subjectBinding: randomSubject,
    capabilityFacet: clone(capabilityFacet(capabilityOverrides)),
  };
  const canonical = createGpuHmrCapabilityAcceptanceContract(ordered);
  const shuffled = createGpuHmrCapabilityAcceptanceContract(shuffledClone(ordered));
  assert.deepEqual(shuffled, canonical);
  randomContractHashes.add(canonical.contractHash);
}
assert.equal(randomContractHashes.size, 64);

for (const identityField of IDENTITY_FIELDS) {
  for (const level of ['input', 'subjectBinding', 'capabilityFacet']) {
    const candidate = input();
    if (level === 'input') candidate[identityField] = 'identity';
    else candidate[level][identityField] = 'identity';
    assertCreateRejected(candidate);
  }

  for (const level of ['contract', 'subjectBinding', 'capabilityFacet']) {
    const candidate = clone(baseline);
    if (level === 'contract') candidate[identityField] = 'identity';
    else candidate[level][identityField] = 'identity';
    assertIntegrityRejected(candidate);
  }
}

for (const field of CALLER_AUTHORITY_FIELDS) {
  const candidate = input();
  candidate[field] = field === 'obligations' || field.endsWith('Outcomes')
    ? []
    : field === 'evidence' || field.endsWith('Evidence')
      ? {}
      : true;
  assertCreateRejected(candidate);
}

const unchanged = input();
unchanged.subjectBinding.artifactAfterHash = unchanged.subjectBinding.artifactBeforeHash;
assertCreateRejected(unchanged, /artifact_transition_unchanged/);
for (const field of GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SUBJECT_FIELDS) {
  const candidate = input();
  candidate.subjectBinding[field] = `SHA256:${'a'.repeat(64)}`;
  assertCreateRejected(candidate);
}

let proxyTrapCalled = false;
const proxiedInput = new Proxy(input(), {
  ownKeys() {
    proxyTrapCalled = true;
    throw new Error('proxy trap must not execute');
  },
});
assertCreateRejected(proxiedInput, /proxy_forbidden/);
assert.equal(proxyTrapCalled, false);

const nestedProxyInput = input();
nestedProxyInput.subjectBinding = new Proxy(nestedProxyInput.subjectBinding, {
  getOwnPropertyDescriptor() {
    proxyTrapCalled = true;
    throw new Error('nested proxy trap must not execute');
  },
});
assertCreateRejected(nestedProxyInput, /proxy_forbidden/);
assert.equal(proxyTrapCalled, false);

let accessorCalled = false;
const accessorInput = input();
Object.defineProperty(accessorInput, 'subjectBinding', {
  enumerable: true,
  get() {
    accessorCalled = true;
    throw new Error('accessor must not execute');
  },
});
assertCreateRejected(accessorInput, /accessor_or_hidden_field/);
assert.equal(accessorCalled, false);

const nestedAccessorInput = input();
Object.defineProperty(nestedAccessorInput.capabilityFacet, 'artifactFormat', {
  enumerable: true,
  get() {
    accessorCalled = true;
    throw new Error('nested accessor must not execute');
  },
});
assertCreateRejected(nestedAccessorInput, /accessor_or_hidden_field/);
assert.equal(accessorCalled, false);

const symbolInput = input();
symbolInput[Symbol('identity')] = true;
assertCreateRejected(symbolInput, /symbol_key_forbidden/);

const cyclicInput = input();
cyclicInput.cycle = cyclicInput;
assertCreateRejected(cyclicInput, /cycle_forbidden/);

const sparseInput = input();
sparseInput.capabilityFacet.evidenceRefs = new Array(1);
assertCreateRejected(sparseInput, /array_shape_invalid|sparse_or_accessor_array/);

const customPrototypeInput = input();
Object.setPrototypeOf(customPrototypeInput.subjectBinding, { injected: true });
assertCreateRejected(customPrototypeInput, /object_prototype_invalid/);

const nonfiniteInput = input();
nonfiniteInput.unbounded = Number.POSITIVE_INFINITY;
assertCreateRejected(nonfiniteInput, /number_invalid/);
const negativeZeroInput = input();
negativeZeroInput.unbounded = -0;
assertCreateRejected(negativeZeroInput, /number_invalid/);

const oversizedStringInput = input();
oversizedStringInput.unbounded = 'x'.repeat(4097);
assertCreateRejected(oversizedStringInput, /string_invalid/);

const oversizedObjectInput = input();
oversizedObjectInput.unbounded = Object.fromEntries(
  Array.from({ length: 4096 }, (_, index) => [`field${index}`, index]),
);
const originalGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
let oversizedObjectDescriptorsMaterialized = false;
Object.getOwnPropertyDescriptors = (value) => {
  if (value === oversizedObjectInput.unbounded) {
    oversizedObjectDescriptorsMaterialized = true;
  }
  return originalGetOwnPropertyDescriptors(value);
};
try {
  assertCreateRejected(oversizedObjectInput, /object_fields_exceeded/);
} finally {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
}
assert.equal(oversizedObjectDescriptorsMaterialized, false);

const oversizedHiddenObjectInput = input();
oversizedHiddenObjectInput.unbounded = {};
for (let index = 0; index < 4096; index += 1) {
  Object.defineProperty(oversizedHiddenObjectInput.unbounded, `hidden${index}`, {
    configurable: true,
    enumerable: false,
    value: index,
    writable: true,
  });
}
let oversizedHiddenObjectDescriptorsMaterialized = false;
Object.getOwnPropertyDescriptors = (value) => {
  if (value === oversizedHiddenObjectInput.unbounded) {
    oversizedHiddenObjectDescriptorsMaterialized = true;
  }
  return originalGetOwnPropertyDescriptors(value);
};
try {
  assertCreateRejected(oversizedHiddenObjectInput, /object_fields_exceeded/);
} finally {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
}
assert.equal(oversizedHiddenObjectDescriptorsMaterialized, false);

const oversizedSymbolObjectInput = input();
oversizedSymbolObjectInput.unbounded = {};
for (let index = 0; index < 4096; index += 1) {
  oversizedSymbolObjectInput.unbounded[Symbol(`hidden${index}`)] = index;
}
let oversizedSymbolObjectDescriptorsMaterialized = false;
Object.getOwnPropertyDescriptors = (value) => {
  if (value === oversizedSymbolObjectInput.unbounded) {
    oversizedSymbolObjectDescriptorsMaterialized = true;
  }
  return originalGetOwnPropertyDescriptors(value);
};
try {
  assertCreateRejected(oversizedSymbolObjectInput, /object_fields_exceeded/);
} finally {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
}
assert.equal(oversizedSymbolObjectDescriptorsMaterialized, false);

const oversizedArrayInput = input();
oversizedArrayInput.unbounded = new Array(
  GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_ARRAY_LENGTH + 1,
);
let oversizedArrayDescriptorsMaterialized = false;
Object.getOwnPropertyDescriptors = (value) => {
  if (value === oversizedArrayInput.unbounded) {
    oversizedArrayDescriptorsMaterialized = true;
  }
  return originalGetOwnPropertyDescriptors(value);
};
try {
  assertCreateRejected(oversizedArrayInput, /array_shape_invalid/);
} finally {
  Object.getOwnPropertyDescriptors = originalGetOwnPropertyDescriptors;
}
assert.equal(oversizedArrayDescriptorsMaterialized, false);

const oversizedDepthInput = input();
oversizedDepthInput.unbounded = {};
let depthCursor = oversizedDepthInput.unbounded;
for (let depth = 0; depth < 34; depth += 1) {
  depthCursor.next = {};
  depthCursor = depthCursor.next;
}
assertCreateRejected(oversizedDepthInput, /depth_exceeded/);

const oversizedNodesInput = input();
oversizedNodesInput.unbounded = Array.from(
  { length: 128 },
  () => Array.from({ length: 32 }, () => ({})),
);
assertCreateRejected(oversizedNodesInput, /nodes_exceeded/);

const oversizedFieldsInput = input();
oversizedFieldsInput.unbounded = Array.from(
  { length: 65 },
  () => Array.from({ length: 128 }, () => 1),
);
assertCreateRejected(oversizedFieldsInput, /fields_exceeded/);

const duplicateAliasInput = input();
const duplicateAlias = { value: 'duplicate' };
duplicateAliasInput.aliasOne = duplicateAlias;
duplicateAliasInput.aliasTwo = duplicateAlias;
assertCreateRejected(duplicateAliasInput, /duplicate_alias_forbidden/);

for (const [field, forgedValue] of [
  ['acceptedAsSupportEvidence', true],
  ['acceptedForGpuHmr', true],
  ['gpuHmrSuccess', true],
  ['canSatisfyRuntimeProof', true],
  ['canSatisfyDispatchProof', true],
  ['valid', false],
  ['authority', 'runtime_dispatch_gpu_hmr_acceptance_authority'],
  ['contractHash', randomHash()],
  ['proofId', `gpu-hmr-capability-acceptance-contract:${randomHash()}`],
  ['subjectBindingHash', randomHash()],
  ['capabilityBindingHash', randomHash()],
]) {
  const forged = clone(baseline);
  forged[field] = forgedValue;
  assertIntegrityRejected(forged);
}

const forgedObligations = clone(baseline);
forgedObligations.obligations = [...forgedObligations.obligations].reverse();
assertIntegrityRejected(forgedObligations);
const forgedFacetSupport = clone(baseline);
forgedFacetSupport.capabilityFacet.acceptedAsSupportEvidence = true;
assertIntegrityRejected(forgedFacetSupport);
assertIntegrityRejected(new Proxy(clone(baseline), {}));
const cyclicContract = clone(baseline);
cyclicContract.subjectBinding.cycle = cyclicContract;
assertIntegrityRejected(cyclicContract);

const capabilityModuleSources = [
  '../lib/gpu-hmr-capability-acceptance-contract.mjs',
  '../lib/gpu-hmr-runtime-adapter-capabilities-versioned.mjs',
  '../lib/gpu-hmr-runtime-adapter-capabilities-v2.mjs',
].map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
for (const moduleSource of capabilityModuleSources) {
  assert.doesNotMatch(moduleSource, /\bbackend(?:Name)?\b/i);
  assert.doesNotMatch(
    moduleSource,
    /\b(?:cuda|rocm|vulkan|webgpu|opencl|metal|directx|bevy|unity|unreal)\b/i,
  );
  const identityBranchLines = moduleSource.split(/\r?\n/).filter((line) => (
    /\b(?:if|switch|case)\b/.test(line)
    && /\b(?:project|target|profile|fixture|library|scenario|family|backend)\b/i.test(line)
  ));
  assert.deepEqual(identityBranchLines, []);
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  capabilityCombinations,
  deterministicRandomBindings: randomContractHashes.size,
  identityFieldsRejectedAtRecordLevels: IDENTITY_FIELDS.length * 6,
  declarationOnly: true,
})}\n`);
