#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateGpuHmrProofLedger,
  assertGpuHmrProofLedgerSuccess,
  buildGpuHmrProofLedger,
  GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
} from './lib/gpu-hmr-proof-ledger.mjs';
import { buildValidationRuntimeProofArtifact } from './lib/gpu-hmr-validation-proof-artifact.mjs';
import { buildGpuHmrValidationProofSummary } from './lib/gpu-hmr-validation-proof-summary.mjs';

const HASH_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

function baselineRecord(overrides = {}) {
  return {
    project_id: 'adversarial-generic-project',
    edit_id: 'gpu-artifact-edit',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: HASH_C,
    artifact_before_hash: HASH_A,
    artifact_after_hash: HASH_B,
    loader_event: {
      id: 'load-1',
      artifact_hash: HASH_B,
      process_id: 'pid-1',
      timestamp_monotonic_ns: 100,
    },
    epoch_publish_event: {
      id: 'publish-1',
      epoch: 'epoch-7',
      artifact_hash: HASH_B,
      process_id: 'pid-1',
      timestamp_monotonic_ns: 200,
    },
    dispatch_event: {
      id: 'dispatch-1',
      epoch: 'epoch-7',
      artifact_hash: HASH_B,
      process_id: 'pid-1',
      timestamp_monotonic_ns: 300,
    },
    output_event: {
      id: 'output-1',
      kind: 'buffer_checksum',
      epoch: 'epoch-7',
      artifact_hash: HASH_B,
      after_dispatch_id: 'dispatch-1',
      passed: true,
      timestamp_monotonic_ns: 400,
    },
    retirement_event: {
      id: 'retire-1',
      epoch: 'epoch-6',
      proof: 'no_retirement_required',
    },
    process_identity: {
      process_id: 'pid-1',
    },
    device_identity: {
      device_uuid: 'device-1',
    },
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    ...overrides,
  };
}

function expectReject(name, record, expectedCode) {
  const result = evaluateGpuHmrProofLedger(record);
  assert.equal(result.gpuHmrSuccess, false, `${name} unexpectedly accepted`);
  assert.ok(
    result.failedInvariants.some((failure) => failure.code === expectedCode),
    `${name} expected ${expectedCode}, got ${result.failedInvariants.map((f) => f.code).join(',')}`,
  );
  return result;
}

const accepted = assertGpuHmrProofLedgerSuccess(baselineRecord());
assert.equal(accepted.schemaVersion, GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION);
assert.equal(accepted.gpuHmrSuccess, true);

const acceptedLedger = buildGpuHmrProofLedger(baselineRecord());
const runtimeArtifact = buildValidationRuntimeProofArtifact({
  workspaceSlug: 'adversarial-generic-project',
  proofLedgerRecord: baselineRecord(),
  fullRuntimeProof: {
    resultState: 'gpu-hmr-full-runtime-proven',
    fullRuntimeProven: true,
    stages: [],
  },
});
assert.equal(runtimeArtifact.proofLedger.gpuHmrSuccess, true);
assert.equal(runtimeArtifact.proofLedgerQuery.gpuHmrSuccess, true);
assert.equal(runtimeArtifact.gpuHmrSuccess, true);

const summary = buildGpuHmrValidationProofSummary({
  workspaceSlug: 'adversarial-generic-project',
  proofLedger: acceptedLedger,
  runtimeProofArtifactRecords: [{
    path: 'memory://runtime-proof-artifact.json',
    proofLedger: runtimeArtifact.proofLedger,
    proofLedgerQuery: runtimeArtifact.proofLedgerQuery,
    gpuHmrSuccess: runtimeArtifact.gpuHmrSuccess,
  }],
});
assert.equal(summary.gpu_hmr_success, true);
assert.equal(summary.proof_states.proof_ledger.gpu_hmr_success, true);

assertGpuHmrProofLedgerSuccess(baselineRecord({
  output_event: {
    id: 'output-visual-1',
    kind: 'render_target_hash',
    epoch: 'epoch-7',
    artifact_hash: HASH_B,
    after_dispatch_id: 'dispatch-1',
    passed: true,
    timestamp_monotonic_ns: 400,
  },
  deterministic_visual_mode: {
    fixed_seed: true,
    frozen_camera: true,
    frame_capture_after_epoch_dispatch: true,
  },
}));

const cases = [
  ['cpu fallback', baselineRecord({ cpu_hmr_used: true }), 'cpu_hmr_used'],
  ['full rebuild', baselineRecord({ full_rebuild_used: true }), 'full_rebuild_used'],
  ['process restart', baselineRecord({ process_restarted: true }), 'process_restarted'],
  ['artifact not loaded', baselineRecord({ loader_event: { artifact_hash: HASH_A, process_id: 'pid-1' } }), 'loader_artifact_hash_mismatch'],
  ['publish mismatched artifact', baselineRecord({ epoch_publish_event: { epoch: 'epoch-7', artifact_hash: HASH_A, process_id: 'pid-1' } }), 'epoch_publish_artifact_hash_mismatch'],
  ['old epoch dispatch', baselineRecord({ dispatch_event: { id: 'dispatch-1', epoch: 'epoch-6', artifact_hash: HASH_B, process_id: 'pid-1', timestamp_monotonic_ns: 300 } }), 'dispatch_epoch_mismatch'],
  ['output from stale dispatch', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, after_dispatch_id: 'dispatch-old', passed: true, timestamp_monotonic_ns: 400 } }), 'output_after_dispatch_id_mismatch'],
  ['output before dispatch', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 250 } }), 'output_precedes_dispatch'],
  ['output oracle failed', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, after_dispatch_id: 'dispatch-1', passed: false, timestamp_monotonic_ns: 400 } }), 'output_oracle_not_passed'],
  ['visual without deterministic mode', baselineRecord({ output_event: { kind: 'render_target_hash', epoch: 'epoch-7', artifact_hash: HASH_B, after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 400 } }), 'visual_output_without_deterministic_mode'],
  ['loader process mismatch', baselineRecord({ loader_event: { id: 'load-1', artifact_hash: HASH_B, process_id: 'pid-2', timestamp_monotonic_ns: 100 } }), 'loader_process_identity_mismatch'],
];

const rejected = cases.map(([name, record, expectedCode]) => {
  const result = expectReject(name, record, expectedCode);
  return { name, expectedCode, failedInvariants: result.failedInvariants.map((failure) => failure.code) };
});

const rejectedArtifact = buildValidationRuntimeProofArtifact({
  workspaceSlug: 'adversarial-generic-project',
  proofLedgerRecord: baselineRecord({ cpu_hmr_used: true }),
});
const rejectedSummary = buildGpuHmrValidationProofSummary({
  workspaceSlug: 'adversarial-generic-project',
  runtimeProofArtifactRecords: [{
    path: 'memory://rejected-runtime-proof-artifact.json',
    proofLedger: rejectedArtifact.proofLedger,
    proofLedgerQuery: rejectedArtifact.proofLedgerQuery,
    gpuHmrSuccess: rejectedArtifact.gpuHmrSuccess,
  }],
});
assert.equal(rejectedSummary.gpu_hmr_success, false);
assert.ok(
  rejectedSummary.limitations.some((limitation) =>
    limitation.stage_id === 'proof-ledger'
    && limitation.degraded_reason === 'cpu_hmr_used'
  ),
);

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
  acceptedProofId: accepted.proofId,
  artifactProofId: runtimeArtifact.proofId,
  rejected,
}, null, 2));
