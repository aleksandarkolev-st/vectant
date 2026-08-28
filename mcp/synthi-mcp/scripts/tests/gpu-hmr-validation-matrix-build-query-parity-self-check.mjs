#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  buildGpuHmrValidationMatrixLedger,
  GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
  queryGpuHmrValidationMatrixLedger,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';

function refusalRow(index) {
  const targetId = `matrix-build-query-parity-refusal-${index}`;
  return {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    backend: ['hip', 'opencl', 'vulkan', 'webgpu'][index % 4],
    targetId,
    target_id: targetId,
    profileId: targetId,
    profile_id: targetId,
    proofMode: 'adversarial_refusal_fixture',
    proof_mode: 'adversarial_refusal_fixture',
    matrixOutcome: 'refusal_proven',
    matrix_outcome: 'refusal_proven',
    acceptanceClass: 'refusal_proven',
    acceptance_class: 'refusal_proven',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    refusalProven: true,
    refusal_proven: true,
    proofChainAccepted: true,
    proof_chain_accepted: true,
    proofChain: 'adversarial_refusal_fixture',
    proof_chain: 'adversarial_refusal_fixture',
    reasons: ['adversarial_refusal_fixture'],
    openGaps: [],
    open_gaps: [],
    updatedAt: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
  };
}

const ledger = buildGpuHmrValidationMatrixLedger(
  Array.from({ length: 8 }, (_, index) => refusalRow(index)),
  {
    generatedAt: '2026-07-17T00:00:00.000Z',
    includeUnproven: true,
  },
);
const independentQuery = queryGpuHmrValidationMatrixLedger(ledger);

assert.equal(ledger.rows.length, 8);
assert.equal(ledger.query.accepted, true);
assert.equal(independentQuery.accepted, true);
assert.deepEqual(ledger.query.failedGates, []);
assert.deepEqual(independentQuery.failedGates, []);
assert.deepEqual(ledger.summary, independentQuery.summary);
assert.equal(ledger.proofId, independentQuery.proofId);
assert.equal(ledger.summary.refusalProvenRows, 8);

console.log('gpu hmr validation matrix build/query parity self-check passed');
