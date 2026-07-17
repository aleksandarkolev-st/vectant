#!/usr/bin/env node
import assert from 'node:assert/strict';

import {
  GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS,
  GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS,
  classifyGpuHmrOutputOracleKind,
} from '../lib/gpu-hmr-output-oracle-kind.mjs';
import {
  GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
  buildGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from '../lib/gpu-hmr-proof-ledger.mjs';
import { runtimeProofArtifactStrictGate } from '../lib/gpu-hmr-proof-strict-gates.mjs';
import { buildRuntimeBoundaryStageEvidence } from '../lib/gpu-hmr-runtime-boundary-proof-adapter.mjs';
import { selfCheckGenericOutputOracleLedger } from '../lib/gpu-hmr-validation-matrix-ledger.mjs';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;

function modelProvenance() {
  const entry = (requestMode, model) => ({
    provider: 'google_gemini',
    requested_model: model,
    provider_model_status: 'available',
    provider_model_alias_resolved_to: null,
    provider_shutdown_or_deprecation_detected: false,
    model_availability_checked_at: '2026-07-17T00:00:00.000Z',
    model_availability_source: 'https://ai.google.dev/gemini-api/docs/deprecations',
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 0,
    actual_model: model,
    fallback_model: null,
    fallback_used: false,
    request_mode: requestMode,
    hard_infra_failure: false,
  });
  return {
    split: entry('split', 'gemini-3.5-flash'),
    last_gpu_delta: entry('gpu_delta', 'gemini-3.1-flash-lite'),
  };
}

function timings() {
  return {
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'compiler_cache_warm',
    static_discovery_time: 1,
    ai_contract_synthesis_time: 2,
    model_availability_check_time: 3,
    artifact_hash_time: 4,
    adapter_generation_time: 5,
    device_compile_wall_time: 6,
    artifact_load_time: 7,
    epoch_publish_time: 8,
    dispatch_trace_time: 9,
    runtime_probe_time: 10,
    oracle_analysis_time: 11,
    trigger_to_visible_time: 12,
    screenshot_capture_time: 13,
    dispatch_to_output_proof_time: 14,
    total_validator_wall_time: 15,
  };
}

function computeArtifacts() {
  return {
    raw_readback_bin: 'memory://oracle-kind-readback.bin',
    readback_schema_json: 'memory://oracle-kind-readback-schema.json',
    checksum_before: HASH_A,
    checksum_after: HASH_B,
    deterministic_slice: { offset: 0, length: 64, format: 'float32', hash: HASH_C },
    deterministic_slice_hash: HASH_C,
    deterministic_slice_hash_verified: true,
    raw_readback_hash: HASH_B,
    raw_readback_hash_verified: true,
    raw_readback_byte_length: 128,
    raw_readback_source: 'runtime_readback_sample',
    raw_readback_verification: {
      hash_verified: true,
      byte_length: 128,
      deterministic_slice_hash: HASH_C,
      deterministic_slice_hash_verified: true,
      slice_bounds_verified: true,
    },
    oracle_code_hash: HASH_C,
    rendered_card_png: 'memory://oracle-kind-proof-card.png',
    producer: 'output_oracle_kind_self_check',
    timestamp_after_dispatch: 400,
    epoch: 'epoch-7',
  };
}

function computeRecord(kind = 'buffer_checksum') {
  return {
    schema_version: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    project_id: 'generic-output-oracle-protocol-self-check',
    edit_id: 'gpu-artifact-edit',
    backend: 'hip',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.95,
      blocking_gaps: [],
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
      kind,
      epoch: 'epoch-7',
      artifact_hash: HASH_B,
      process_id: 'pid-1',
      after_dispatch_id: 'dispatch-1',
      passed: true,
      timestamp_monotonic_ns: 400,
    },
    retirement_event: {
      id: 'retire-1',
      epoch: 'epoch-6',
      proof: 'no_retirement_required',
      timestamp_monotonic_ns: 500,
    },
    process_identity: { process_id: 'pid-1' },
    device_identity: { device_uuid: 'device-1' },
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    oracle_artifacts: { compute_oracle_artifacts: computeArtifacts() },
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'compiler_cache_warm',
    timings: timings(),
    model_provenance: modelProvenance(),
    evidence_refs: [
      'runtime:module-load',
      'runtime:epoch-publish',
      'runtime:dispatch',
      'runtime:output-oracle',
    ],
  };
}

for (const kind of GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS) {
  const classification = classifyGpuHmrOutputOracleKind(kind);
  assert.equal(classification.accepted, true, kind);
  assert.equal(classification.modality, 'compute', kind);
  assert.equal(classification.topLevelKind, 'compute_oracle', kind);
}
for (const kind of GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS) {
  const classification = classifyGpuHmrOutputOracleKind(kind);
  assert.equal(classification.accepted, true, kind);
  assert.equal(classification.modality, 'visual', kind);
  assert.equal(classification.topLevelKind, 'visual_oracle', kind);
}
assert.equal(
  GPU_HMR_COMPUTE_OUTPUT_ORACLE_KINDS.some((kind) =>
    GPU_HMR_VISUAL_OUTPUT_ORACLE_KINDS.includes(kind)),
  false,
);

for (const kind of ['buffer_checksum', 'compute_readback', 'compute_oracle']) {
  const query = queryGpuHmrLedgerInvariants(buildGpuHmrProofLedger(computeRecord(kind)));
  assert.equal(query.gpuHmrSuccess, true, `${kind}: ${JSON.stringify(query.failedInvariants)}`);
}

const deceptiveKinds = [
  'dataframe_checksum',
  'renderless_compute',
  'pixelated_metadata',
  'project_visual',
  'profile_render',
  'fixture_frame',
  'raytraced_visual_oracle',
  'webgpu_visual_oracle',
];
for (const kind of deceptiveKinds) {
  const classification = classifyGpuHmrOutputOracleKind(kind);
  assert.equal(classification.accepted, false, kind);
  assert.equal(classification.modality, null, kind);
  assert.equal(classification.failureCode, 'output_oracle_kind_unknown', kind);

  const ledger = buildGpuHmrProofLedger(computeRecord(kind));
  const query = queryGpuHmrLedgerInvariants(ledger);
  const codes = query.failedInvariants.map((failure) => failure.code);
  assert.equal(query.gpuHmrSuccess, false, kind);
  assert.ok(codes.includes('output_oracle_kind_unknown'), `${kind}: ${codes.join(',')}`);
  assert.equal(codes.includes('visual_output_without_deterministic_mode'), false, kind);
  assert.equal(codes.includes('visual_oracle_artifacts_missing'), false, kind);

  const strictGate = runtimeProofArtifactStrictGate({
    proofId: `gpu-runtime-proof:${HASH_C}`,
    proofLedger: ledger,
    proofLedgerQuery: query,
  });
  assert.ok(strictGate.failures.includes('output_oracle_kind_unknown'), kind);
}

const missingKindRecord = computeRecord();
delete missingKindRecord.output_event.kind;
const missingKindQuery = queryGpuHmrLedgerInvariants(buildGpuHmrProofLedger(missingKindRecord));
assert.ok(missingKindQuery.failedInvariants.some(
  (failure) => failure.code === 'output_oracle_kind_missing',
));

const boundaryEvent = (oracleKind) => ({
  kind: 'output_oracle',
  eventId: 'output-1',
  artifactHash: HASH_B,
  epoch: 'epoch-7',
  afterDispatchId: 'dispatch-1',
  processId: 'pid-1',
  runtimeSession: 'runtime-session-1',
  outputTargetId: 'output-1',
  oracleKind,
  timestampMonotonicNs: 400,
  evidenceRefs: ['runtime:output-oracle'],
});
const legitimateBoundary = buildRuntimeBoundaryStageEvidence([boundaryEvent('render_target_hash')]);
assert.equal(legitimateBoundary.failedGates.includes('output_oracle_kind_unknown'), false);
const deceptiveBoundary = buildRuntimeBoundaryStageEvidence([boundaryEvent('pixelated_metadata')]);
assert.ok(deceptiveBoundary.failedGates.includes('output_oracle_kind_unknown'));

const matrixSelfCheck = await selfCheckGenericOutputOracleLedger();
assert.equal(matrixSelfCheck.ok, true);
assert.equal(matrixSelfCheck.acceptedFacet.kind, 'compute_oracle');

console.log('gpu hmr output oracle kind self-check passed');
