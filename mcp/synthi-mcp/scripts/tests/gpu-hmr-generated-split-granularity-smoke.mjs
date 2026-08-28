#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assessGeneratedGpuSplitGranularity,
  assertNoGeneratedSplitFissionOverclaim,
  deviceKernelSymbolsFromSource,
  manifestDeviceRoles,
  verifyGeneratedGpuSplitDeterministicFission,
  GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION,
  GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_SCHEMA_VERSION,
  GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
} from '../lib/gpu-hmr-generated-split-granularity.mjs';
import { classifyGpuHmrFissionProof } from '../lib/gpu-hmr-runtime-proof.mjs';

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sha256Address(value) {
  return `sha256:${sha256Hex(stableJson(value))}`;
}

function selectedIslandIdFor(selectedPath, selectedKernel) {
  return `kernel:${selectedKernel}:${sha256Hex(selectedPath).slice(0, 16)}`;
}

function typedFissionEvidence(category, evidenceType, subject, payload = {}) {
  const contentHash = sha256Address({
    schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    category,
    evidenceType,
    subject,
    payload,
  });
  const evidenceHash = sha256Hex(stableJson({ category, evidenceType, contentHash, subject }));
  return {
    schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    category,
    evidenceType,
    evidenceRefs: [`evidence:generated-split-fission:${category}:sha256:${evidenceHash}`],
    contentHash,
    subject,
    payload,
  };
}

function deterministicFissionEvidenceFor({ selectedPath, selectedKernel, selectedIslandId }) {
  const subject = {
    selectedPath,
    sourcePaths: [selectedPath],
    selectedIslandId,
    targetSymbols: [selectedKernel],
  };
  return [
    typedFissionEvidence('selected_island_binding', 'selected_island_binding', subject, {
      binding: 'selected-generated-device-kernel',
    }),
    typedFissionEvidence('source_mapping', 'source_mapping', subject, {
      mappedSource: selectedPath,
    }),
    typedFissionEvidence('include_closure', 'include_closure', subject, {
      includedDependencies: [],
    }),
    typedFissionEvidence('symbol_ownership', 'symbol_ownership', subject, {
      ownedSymbols: [selectedKernel],
    }),
    typedFissionEvidence('dependency_closure', 'dependency_closure', subject, {
      changedPaths: [selectedPath],
      unchangedRolesObserved: true,
    }),
    typedFissionEvidence('abi_membrane', 'abi_membrane', subject, {
      compatibilityClass: 'compatible',
    }),
    typedFissionEvidence('compile_recipe', 'compile_proof', subject, {
      compiler: 'hipcc',
      arch: ['gfx1201'],
    }),
    typedFissionEvidence('loader_capability', 'loader_runtime_proof', subject, {
      transport: 'runtime-loader',
    }),
    typedFissionEvidence('output_oracle', 'output_oracle_proof', subject, {
      oracleKind: 'visual',
    }),
  ];
}

const singleRoleManifest = {
  gpu: {
    vendor: 'rocm',
    device_roles: [{
      id: 'device.device',
      path: '.synthi/generated/gpu/device.hip',
      compiler: 'hipcc',
      arch: ['gfx1201'],
    }],
  },
};

const multiRoleManifest = {
  gpu: {
    vendor: 'rocm',
    device_roles: [
      { id: 'device.integrator', path: 'gpu/integrator.hip', compiler: 'hipcc' },
      { id: 'device.shading', path: 'gpu/shading.hip', compiler: 'hipcc' },
    ],
  },
};

assert.deepEqual(
  deviceKernelSymbolsFromSource(`
    // __global__ void ignored_comment() {}
    extern "C" __global__ void integrate(float* out) {}
    __global__ void shade(float* out) {}
    __kernel void opencl_step(__global float* out) {}
  `),
  ['integrate', 'shade', 'opencl_step'],
);

assert.equal(manifestDeviceRoles(singleRoleManifest)[0].path, '.synthi/generated/gpu/device.hip');

const explicitModuleDeviceManifest = {
  module_files: {
    device: 'gpu/declared-device.hip',
  },
  gpu: {
    vendor: 'rocm',
  },
};
assert.equal(manifestDeviceRoles(explicitModuleDeviceManifest)[0].path, 'gpu/declared-device.hip');

const missingDeviceTopologyManifest = {
  module_files: {
    shared: 'shared.h',
  },
  gpu: {
    vendor: 'rocm',
  },
};
const missingDeviceTopologyAssessment = assessGeneratedGpuSplitGranularity({
  manifest: missingDeviceTopologyManifest,
  files: {
    'device.hip': 'extern "C" __global__ void should_not_be_inferred() {}\n',
  },
});
assert.equal(manifestDeviceRoles(missingDeviceTopologyManifest).length, 0);
assert.equal(missingDeviceTopologyAssessment.deviceRoleCount, 0);
assert.ok(missingDeviceTopologyAssessment.reasonCodes.includes('generated_split.device_roles_missing'));

const singleRoleAssessment = assessGeneratedGpuSplitGranularity({
  manifest: singleRoleManifest,
  files: {
    '.synthi/generated/gpu/device.hip': `
      #include <hip/hip_runtime.h>
      __global__ void integrate(float* out) {}
      __global__ void shade(float* out) {}
    `,
  },
});
assert.equal(singleRoleAssessment.schemaVersion, GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION);
assert.equal(singleRoleAssessment.acceptedClaim, 'device_translation_unit_hmr');
assert.equal(singleRoleAssessment.deviceTranslationUnitCount, 1);
assert.equal(singleRoleAssessment.kernelCount, 2);
assert.equal(singleRoleAssessment.smallestSafeFissionIslandProven, false);
assert.equal(singleRoleAssessment.perKernelHmrProven, false);
assert.equal(singleRoleAssessment.requiresDeterministicFissionVerifierForSmallestSafeIsland, true);
assert.equal(singleRoleAssessment.requiresDeterministicFissionVerifierForPerKernelHmr, true);
assert.ok(singleRoleAssessment.rejectedClaims.includes('smallest_safe_fission_island'));
assert.ok(singleRoleAssessment.rejectedClaims.includes('per_kernel_hmr'));
assert.doesNotThrow(() => assertNoGeneratedSplitFissionOverclaim(singleRoleAssessment));
assert.throws(
  () => assertNoGeneratedSplitFissionOverclaim({
    ...singleRoleAssessment,
    smallestSafeFissionIslandProven: true,
  }),
  /deterministic verifier proof/,
);
assert.throws(
  () => assertNoGeneratedSplitFissionOverclaim({
    ...singleRoleAssessment,
    acceptedClaim: 'per_kernel_hmr',
    rejectedClaims: ['smallest_safe_fission_island'],
  }),
  /per-kernel HMR without deterministic verifier proof/,
);
assert.throws(
  () => assertNoGeneratedSplitFissionOverclaim({
    ...singleRoleAssessment,
    perKernelHmrProven: true,
  }),
  /per-kernel HMR without deterministic verifier proof/,
);

const multiRoleAssessment = assessGeneratedGpuSplitGranularity({
  manifest: multiRoleManifest,
  files: {
    'gpu/integrator.hip': '__global__ void integrate(float* out) {}',
    'gpu/shading.hip': '__global__ void shade(float* out) {}',
  },
});
assert.equal(multiRoleAssessment.acceptedClaim, 'device_translation_unit_set_hmr');
assert.equal(multiRoleAssessment.deviceTranslationUnitCount, 2);
assert.equal(multiRoleAssessment.kernelCount, 2);
assert.equal(multiRoleAssessment.smallestSafeFissionIslandProven, false);
assert.equal(multiRoleAssessment.perKernelHmrProven, false);
assert.ok(multiRoleAssessment.rejectedClaims.includes('per_kernel_hmr'));

const deterministicOutputOracle = {
  oracleId: 'oracle:visual:sha256:1111111111111111111111111111111111111111111111111111111111111111',
  kind: 'visual',
  target: 'framebuffer',
  epoch: 7,
};

const deterministicSelectedPath = 'gpu/shading.hip';
const deterministicSelectedKernel = 'shade';
const deterministicSelectedIslandId = selectedIslandIdFor(
  deterministicSelectedPath,
  deterministicSelectedKernel,
);
const deterministicFissionEvidence = deterministicFissionEvidenceFor({
  selectedPath: deterministicSelectedPath,
  selectedKernel: deterministicSelectedKernel,
  selectedIslandId: deterministicSelectedIslandId,
});

const deterministicArtifact = {
  sourcePath: deterministicSelectedPath,
  artifactId: 'artifact:sha256:2222222222222222222222222222222222222222222222222222222222222222',
  contentHash: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
  runtimeProofId: 'gpu-runtime-proof:sha256:4444444444444444444444444444444444444444444444444444444444444444',
  ledgerProofId: 'gpu-ledger-proof:sha256:5555555555555555555555555555555555555555555555555555555555555555',
};

const provenPerKernel = verifyGeneratedGpuSplitDeterministicFission({
  assessment: multiRoleAssessment,
  selectedPath: deterministicSelectedPath,
  changedPaths: [deterministicSelectedPath],
  selectedArtifact: deterministicArtifact,
  verificationEvidence: deterministicFissionEvidence,
  outputOracleContract: deterministicOutputOracle,
  abiCompatibilityClass: 'compatible',
  unaffectedArtifactHashesBefore: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  unaffectedArtifactHashesAfter: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  compilerArgsHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
assert.equal(
  provenPerKernel.deterministicFissionVerifier.schemaVersion,
  GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_SCHEMA_VERSION,
);
assert.equal(provenPerKernel.acceptedClaim, 'per_kernel_hmr');
assert.equal(provenPerKernel.fissionGranularity, 'per_kernel');
assert.equal(provenPerKernel.smallestSafeFissionIslandProven, true);
assert.equal(provenPerKernel.perKernelHmrProven, true);
assert.equal(provenPerKernel.deterministicFissionVerifier.accepted, true);
assert.match(
  provenPerKernel.deterministicFissionVerifier.verifierEvidenceId,
  /^evidence:fission-verifier-report:generated-split:sha256:[0-9a-f]{64}$/,
);
assert.deepEqual(
  provenPerKernel.selectedIslandContract.verificationEvidenceCoverage.missingCategories,
  [],
);
assert.equal(
  provenPerKernel.selectedIslandContract.verificationEvidenceCoverage.categories.length,
  9,
);
assert.doesNotThrow(() => assertNoGeneratedSplitFissionOverclaim(provenPerKernel));

const classifiedPerKernel = classifyGpuHmrFissionProof(provenPerKernel.fissionProof);
assert.equal(classifiedPerKernel.fissionProven, true);
assert.equal(classifiedPerKernel.selectedIslandContractCoverageComplete, true);
assert.equal(classifiedPerKernel.deterministicVerifierEvidenceObserved, true);

const legacyBooleanPathOnly = verifyGeneratedGpuSplitDeterministicFission({
  assessment: multiRoleAssessment,
  selectedPath: deterministicSelectedPath,
  changedPaths: [deterministicSelectedPath],
  selectedArtifact: {
    ...deterministicArtifact,
    runtimeProofAccepted: true,
    loaderProofAccepted: true,
  },
  outputOracleContract: deterministicOutputOracle,
  abiCompatibilityClass: 'compatible',
  unaffectedArtifactHashesBefore: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  unaffectedArtifactHashesAfter: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  compilerArgsHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
assert.equal(legacyBooleanPathOnly.perKernelHmrProven, false);
assert.ok(legacyBooleanPathOnly.reasonCodes.includes(
  'generated_split.selected_island_binding_typed_evidence_missing',
));
assert.ok(legacyBooleanPathOnly.reasonCodes.includes(
  'generated_split.dependency_closure_typed_evidence_missing',
));
assert.ok(legacyBooleanPathOnly.reasonCodes.includes(
  'generated_split.compile_recipe_typed_evidence_missing',
));
assert.ok(legacyBooleanPathOnly.reasonCodes.includes(
  'generated_split.loader_capability_typed_evidence_missing',
));
assert.ok(legacyBooleanPathOnly.reasonCodes.includes(
  'generated_split.output_oracle_typed_evidence_missing',
));
assert.doesNotThrow(() => assertNoGeneratedSplitFissionOverclaim(legacyBooleanPathOnly));

const forgedPerKernel = {
  ...provenPerKernel,
  deterministicFissionVerifier: {
    ...provenPerKernel.deterministicFissionVerifier,
    verifierEvidenceId: 'evidence:generated-fission:verifier_report:sha256:forged',
  },
};
assert.throws(
  () => assertNoGeneratedSplitFissionOverclaim(forgedPerKernel),
  /deterministic verifier proof/,
);

const missingOracle = verifyGeneratedGpuSplitDeterministicFission({
  assessment: multiRoleAssessment,
  selectedPath: 'gpu/shading.hip',
  changedPaths: ['gpu/shading.hip'],
  selectedArtifact: deterministicArtifact,
  verificationEvidence: deterministicFissionEvidence,
  outputOracleContract: {},
  unaffectedArtifactHashesBefore: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  unaffectedArtifactHashesAfter: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  compilerArgsHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
assert.equal(missingOracle.perKernelHmrProven, false);
assert.ok(missingOracle.reasonCodes.includes('generated_split.output_oracle_contract_missing'));
assert.doesNotThrow(() => assertNoGeneratedSplitFissionOverclaim(missingOracle));

const hiddenFullRebuild = verifyGeneratedGpuSplitDeterministicFission({
  assessment: multiRoleAssessment,
  selectedPath: 'gpu/shading.hip',
  changedPaths: ['gpu/shading.hip'],
  selectedArtifact: deterministicArtifact,
  verificationEvidence: deterministicFissionEvidence,
  outputOracleContract: deterministicOutputOracle,
  fullRebuildUsed: true,
  unaffectedArtifactHashesBefore: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  unaffectedArtifactHashesAfter: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  compilerArgsHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
assert.equal(hiddenFullRebuild.perKernelHmrProven, false);
assert.ok(hiddenFullRebuild.reasonCodes.includes('generated_split.loader_firewall_not_proven'));

const layoutChanged = verifyGeneratedGpuSplitDeterministicFission({
  assessment: multiRoleAssessment,
  selectedPath: 'gpu/shading.hip',
  changedPaths: ['gpu/shading.hip'],
  selectedArtifact: deterministicArtifact,
  verificationEvidence: deterministicFissionEvidence,
  outputOracleContract: deterministicOutputOracle,
  abiCompatibilityClass: 'layout_changed',
  unaffectedArtifactHashesBefore: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  unaffectedArtifactHashesAfter: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  compilerArgsHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
assert.equal(layoutChanged.perKernelHmrProven, false);
assert.ok(layoutChanged.reasonCodes.includes('generated_split.abi_class_not_accepted'));

const multiKernelSelection = verifyGeneratedGpuSplitDeterministicFission({
  assessment: singleRoleAssessment,
  selectedPath: '.synthi/generated/gpu/device.hip',
  changedPaths: ['.synthi/generated/gpu/device.hip'],
  selectedArtifact: {
    sourcePath: '.synthi/generated/gpu/device.hip',
    artifactId: 'artifact:sha256:4444444444444444444444444444444444444444444444444444444444444444',
  },
  outputOracleContract: deterministicOutputOracle,
  compilerArgsHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
assert.equal(multiKernelSelection.perKernelHmrProven, false);
assert.ok(multiKernelSelection.reasonCodes.includes('generated_split.selected_role_not_single_kernel'));

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION,
  singleRoleAcceptedClaim: singleRoleAssessment.acceptedClaim,
  multiRoleAcceptedClaim: multiRoleAssessment.acceptedClaim,
  deterministicFissionSchemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_SCHEMA_VERSION,
  perKernelVerifierAccepted: provenPerKernel.deterministicFissionVerifier.accepted,
}, null, 2));
