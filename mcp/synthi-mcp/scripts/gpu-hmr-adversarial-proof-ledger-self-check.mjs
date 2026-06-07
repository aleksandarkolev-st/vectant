#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateGpuHmrProofLedger,
  assertGpuHmrProofLedgerSuccess,
  buildGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
  GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
} from './lib/gpu-hmr-proof-ledger.mjs';
import { GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION } from './lib/gpu-hmr-acceptance-contract.mjs';
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

function baselineContract(overrides = {}) {
  return {
    contract_version: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    contract_hash: HASH_C,
    project_id: 'adversarial-generic-project',
    edit_id: 'gpu-artifact-edit',
    backend: 'hip',
    confidence: 0.95,
    evidence_refs: ['static:hip-launch', 'runtime:loader', 'runtime:dispatch'],
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.95,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: ['src/kernels/generic.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['generic_kernel'],
      compile_target: 'gfx1201',
      compiler: 'hipcc',
      compiler_args_hash: HASH_C,
    },
    artifact_hash_before: HASH_A,
    artifact_hash_after: HASH_B,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: 'compatible',
      evidence_refs: ['code-object:metadata'],
    },
    reload_mechanism: 'generated_adapter',
    adapter_outcome: 'adapter_generated',
    reload_evidence_refs: ['runtime:module-load'],
    dispatch_trace_required: true,
    oracle_trace_required: true,
    epoch_retirement_proof: {
      value: 'stream_event_proven',
      evidence_refs: ['runtime:stream-event'],
    },
    fission_report: {
      selected_island: 'device-kernel',
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
    },
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
  acceptanceContract: baselineContract(),
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
assert.equal(runtimeArtifact.acceptanceContractEvaluation.accepted, true);

const summary = buildGpuHmrValidationProofSummary({
  workspaceSlug: 'adversarial-generic-project',
  proofLedger: acceptedLedger,
  acceptanceContract: baselineContract(),
  runtimeProofArtifactRecords: [{
    path: 'memory://runtime-proof-artifact.json',
    acceptanceContract: runtimeArtifact.acceptanceContract,
    acceptanceContractEvaluation: runtimeArtifact.acceptanceContractEvaluation,
    proofLedger: runtimeArtifact.proofLedger,
    proofLedgerQuery: runtimeArtifact.proofLedgerQuery,
    gpuHmrSuccess: runtimeArtifact.gpuHmrSuccess,
  }],
});
assert.equal(summary.gpu_hmr_success, true);
assert.equal(summary.proof_states.proof_ledger.gpu_hmr_success, true);
assert.equal(summary.proof_states.acceptance_contract.accepted, true);

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
    temporal_accumulation_disabled: true,
    taa_disabled: true,
    denoiser_disabled: true,
    fixed_resolution: true,
    fixed_swapchain_image_count: true,
    frame_capture_after_epoch_dispatch: true,
    presentation_fence_or_frame_boundary: true,
  },
}));

const cases = [
  ['cpu fallback', baselineRecord({ cpu_hmr_used: true }), 'cpu_hmr_used'],
  ['full rebuild', baselineRecord({ full_rebuild_used: true }), 'full_rebuild_used'],
  ['process restart', baselineRecord({ process_restarted: true }), 'process_restarted'],
  ['missing contract hash', baselineRecord({ contract_hash: null }), 'contract_hash_missing'],
  ['missing artifact before hash', baselineRecord({ artifact_before_hash: null }), 'artifact_before_hash_missing'],
  ['unchanged artifact hash', baselineRecord({ artifact_before_hash: HASH_B }), 'artifact_hash_unchanged'],
  ['artifact not loaded', baselineRecord({ loader_event: { artifact_hash: HASH_A, process_id: 'pid-1' } }), 'loader_artifact_hash_mismatch'],
  ['publish mismatched artifact', baselineRecord({ epoch_publish_event: { epoch: 'epoch-7', artifact_hash: HASH_A, process_id: 'pid-1' } }), 'epoch_publish_artifact_hash_mismatch'],
  ['old epoch dispatch', baselineRecord({ dispatch_event: { id: 'dispatch-1', epoch: 'epoch-6', artifact_hash: HASH_B, process_id: 'pid-1', timestamp_monotonic_ns: 300 } }), 'dispatch_epoch_mismatch'],
  ['stale artifact dispatch', baselineRecord({ dispatch_event: { id: 'dispatch-1', epoch: 'epoch-7', artifact_hash: HASH_A, process_id: 'pid-1', timestamp_monotonic_ns: 300 } }), 'dispatch_artifact_hash_mismatch'],
  ['output from stale dispatch', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, after_dispatch_id: 'dispatch-old', passed: true, timestamp_monotonic_ns: 400 } }), 'output_after_dispatch_id_mismatch'],
  ['output before dispatch', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 250 } }), 'output_precedes_dispatch'],
  ['output oracle failed', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, after_dispatch_id: 'dispatch-1', passed: false, timestamp_monotonic_ns: 400 } }), 'output_oracle_not_passed'],
  ['visual without deterministic mode', baselineRecord({ output_event: { kind: 'render_target_hash', epoch: 'epoch-7', artifact_hash: HASH_B, after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 400 } }), 'visual_output_without_deterministic_mode'],
  ['loader process mismatch', baselineRecord({ loader_event: { id: 'load-1', artifact_hash: HASH_B, process_id: 'pid-2', timestamp_monotonic_ns: 100 } }), 'loader_process_identity_mismatch'],
  ['missing device identity', baselineRecord({ device_identity: {} }), 'device_identity_missing'],
  ['missing retirement event', baselineRecord({ retirement_event: {} }), 'retirement_event_missing'],
  ['missing retirement proof', baselineRecord({ retirement_event: { id: 'retire-1', epoch: 'epoch-6' } }), 'retirement_proof_missing'],
  ['host-only classification', baselineRecord({ classification: { project_kind: 'gpu_project', edit_kind: 'host_only', route: 'cpu_hmr_or_host_reload' } }), 'classification_host_only_edit'],
];

const rejected = cases.map(([name, record, expectedCode]) => {
  const result = expectReject(name, record, expectedCode);
  return { name, expectedCode, failedInvariants: result.failedInvariants.map((failure) => failure.code) };
});

const forgedLedger = buildGpuHmrProofLedger(baselineRecord({ cpu_hmr_used: true }));
forgedLedger.query = {
  ...forgedLedger.query,
  gpuHmrSuccess: true,
  failedInvariants: [],
};
const forgedQueryResult = queryGpuHmrLedgerInvariants(forgedLedger);
assert.equal(forgedQueryResult.gpuHmrSuccess, false);
assert.ok(
  forgedQueryResult.failedInvariants.some((failure) => failure.code === 'supplied_ledger_query_mismatch'),
  `forged ledger query expected supplied_ledger_query_mismatch, got ${forgedQueryResult.failedInvariants.map((f) => f.code).join(',')}`,
);

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
