#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';

const {
  largeRocmMlRandomColdNormalizedIdentityTerm,
  largeRocmMlRandomColdSemanticTextValues,
  largeRocmMlRandomColdTextSignals,
} = GPU_HMR_VALIDATION_MATRIX_LEDGER_TEST_HOOKS;

const identityTerms = [
  largeRocmMlRandomColdNormalizedIdentityTerm('gemm-tensor-identity-only-cold-readiness-1'),
].filter(Boolean);

assert.deepEqual(
  largeRocmMlRandomColdTextSignals(
    ['src/gpu/gemm-tensor-identity-only-cold-readiness-1-kernel-0.hip'],
    'source_listing',
    { identityTerms },
  ),
  [],
);

const realSourceSignals = largeRocmMlRandomColdTextSignals(
  ['src/gpu/tensor_ops/gemm_kernel_0.hip'],
  'source_listing',
  { identityTerms },
);
assert.ok(realSourceSignals.some((signal) => signal.token === 'gemm'));
assert.ok(realSourceSignals.some((signal) => signal.token === 'tensor'));

assert.deepEqual(
  largeRocmMlRandomColdSemanticTextValues({
    mlDomainSignals: [
      {
        path: 'synthetic/labels/gemm-only-target-name.cc',
        reason: 'tensor_target_label',
      },
    ],
    target: 'hipblaslt_gemm_label_only',
  }),
  [],
);

const explicitSemanticValues = largeRocmMlRandomColdSemanticTextValues({
  mlDomainSignals: [
    {
      token: 'gemm',
      value: 'tensor_core_tile',
    },
  ],
});
assert.deepEqual(explicitSemanticValues, ['gemm', 'tensor_core_tile']);

const semanticSignals = largeRocmMlRandomColdTextSignals(
  explicitSemanticValues,
  'verified_build_metadata',
  { identityTerms },
);
assert.ok(semanticSignals.some((signal) => signal.token === 'gemm'));
assert.ok(semanticSignals.some((signal) => signal.token === 'tensor'));

console.log('gpu-hmr large ROCm ML identity smoke ok');
