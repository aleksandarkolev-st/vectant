#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  assessGeneratedGpuSplitGranularity,
  assertNoGeneratedSplitFissionOverclaim,
  deviceKernelSymbolsFromSource,
  manifestDeviceRoles,
  GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION,
} from '../lib/gpu-hmr-generated-split-granularity.mjs';

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
assert.equal(singleRoleAssessment.requiresDeterministicFissionVerifierForSmallestSafeIsland, true);
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
assert.ok(!multiRoleAssessment.rejectedClaims.includes('per_kernel_hmr'));

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_GENERATED_SPLIT_GRANULARITY_SCHEMA_VERSION,
  singleRoleAcceptedClaim: singleRoleAssessment.acceptedClaim,
  multiRoleAcceptedClaim: multiRoleAssessment.acceptedClaim,
}, null, 2));
