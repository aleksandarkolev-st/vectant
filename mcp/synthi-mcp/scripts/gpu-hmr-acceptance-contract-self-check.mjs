#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  evaluateGpuHmrAcceptanceContract,
  GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
} from './lib/gpu-hmr-acceptance-contract.mjs';

const BEFORE = 'artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AFTER = 'artifact:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function contract(overrides = {}) {
  return {
    contract_version: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    project_id: 'generic-gpu-project',
    edit_id: 'edit-1',
    backend: 'hip',
    confidence: 0.91,
    evidence_refs: ['static:hip-launch', 'runtime:loader'],
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.91,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: ['src/kernels.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['light_kernel'],
      compile_target: 'gfx1201',
      compiler: 'hipcc',
      compiler_args_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    },
    artifact_hash_before: BEFORE,
    artifact_hash_after: AFTER,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: 'compatible',
      evidence_refs: ['code-object:metadata'],
    },
    abi_metadata: {
      kernel_abi_fingerprint_hashes: ['sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'],
      extractor_sources: ['clang_ast'],
    },
    reload_mechanism: 'generated_adapter',
    adapter_outcome: 'adapter_generated',
    reload_evidence_refs: ['runtime:module-load'],
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: 'pid-1',
      device_uuid: 'device-1',
      context_or_device_handle: 'hip-context-1',
      queue_or_stream_handle: 'stream-1',
      persistent_gpu_allocations: ['allocation-1'],
    },
    epoch_policy: {
      publish_mechanism: 'runtime_epoch_publish',
      dispatch_binding: 'dispatch_table_epoch_binding',
      retirement_mechanism: 'stream_event',
    },
    epoch_retirement_proof: {
      value: 'stream_event_proven',
      evidence_refs: ['runtime:stream-event'],
    },
    fission_report: {
      selected_island: 'device-kernel',
      selected_reason: 'verified_fission_contract',
      artifact_hash_before: BEFORE,
      artifact_hash_after: AFTER,
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
    },
    ...overrides,
  };
}

function expectReject(name, patch, expectedCode) {
  const result = evaluateGpuHmrAcceptanceContract(contract(patch));
  assert.equal(result.accepted, false, `${name} unexpectedly accepted`);
  assert.ok(
    result.failedGates.some((gate) => gate.code === expectedCode),
    `${name} expected ${expectedCode}, got ${result.failedGates.map((gate) => gate.code).join(',')}`,
  );
}

const accepted = evaluateGpuHmrAcceptanceContract(contract());
assert.equal(accepted.accepted, true);

expectReject('host-only edit', {
  classification: {
    project_kind: 'gpu_project',
    edit_kind: 'host_only',
    route: 'cpu_hmr_or_host_reload',
  },
}, 'host_only_edit_not_gpu_hmr');
expectReject('cpu route', {
  classification: {
    project_kind: 'gpu_project',
    edit_kind: 'gpu_artifact_edit',
    route: 'cpu_hmr_or_host_reload',
  },
}, 'route_not_gpu_hmr');
expectReject('ai hints only', {
  evidence_refs: [],
  ai_hints: [{ backend: 'hip' }],
}, 'ai_hints_without_verified_evidence');
expectReject('layout change', {
  abi_compatibility_class: {
    value: 'layout_changed',
    evidence_refs: ['code-object:metadata'],
  },
}, 'abi_compatibility_not_proven');
expectReject('unknown ABI', {
  abi_compatibility_class: {
    value: 'unknown',
    evidence_refs: ['code-object:metadata'],
  },
}, 'abi_compatibility_not_proven');
expectReject('metadata-only ABI label', {
  abi_metadata: {},
}, 'abi_metadata_missing');
expectReject('missing reload hook', {
  reload_mechanism: 'unsupported',
}, 'reload_mechanism_unsupported');
expectReject('missing state preservation', {
  state_preservation_checks: {
    device_uuid: 'device-1',
    context_or_device_handle: 'hip-context-1',
    queue_or_stream_handle: 'stream-1',
    persistent_gpu_allocations: ['allocation-1'],
  },
}, 'state_process_id_missing');
expectReject('missing epoch policy', {
  epoch_policy: {},
}, 'epoch_publish_mechanism_missing');
expectReject('missing fission selected reason', {
  fission_report: {
    selected_island: 'device-kernel',
    full_device_fallback: false,
    host_relinked: false,
    process_restarted: false,
    full_rebuild_used: false,
  },
}, 'fission_selected_reason_missing');
expectReject('full rebuild hidden in fission', {
  fission_report: {
    selected_island: 'device-kernel',
    selected_reason: 'verified_fission_contract',
    full_device_fallback: false,
    host_relinked: false,
    process_restarted: false,
    full_rebuild_used: true,
  },
}, 'fission_full_rebuild_used');

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
  acceptedContractHash: accepted.contract.contract_hash,
}, null, 2));
