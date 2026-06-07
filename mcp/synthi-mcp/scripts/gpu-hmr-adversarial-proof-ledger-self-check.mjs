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

function baselineModelProvenance(overrides = {}) {
  return {
    split: {
      provider: 'google_gemini',
      requested_model: 'gemini-3.5-flash',
      provider_model_status: 'available',
      provider_model_alias_resolved_to: null,
      provider_shutdown_or_deprecation_detected: false,
      model_availability_checked_at: '2026-06-07T00:00:00.000Z',
      actual_model: 'gemini-3.5-flash',
      fallback_model: null,
      fallback_used: false,
      request_mode: 'split',
      hard_infra_failure: false,
    },
    last_gpu_delta: {
      provider: 'google_gemini',
      requested_model: 'gemini-3.1-flash-lite',
      provider_model_status: 'deprecated',
      provider_model_alias_resolved_to: null,
      provider_shutdown_or_deprecation_detected: true,
      model_availability_checked_at: '2026-06-07T00:00:00.000Z',
      actual_model: 'gemini-3.1-flash-lite',
      fallback_model: null,
      fallback_used: false,
      request_mode: 'gpu_delta',
      hard_infra_failure: false,
    },
    ...overrides,
  };
}

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
      process_id: 'pid-1',
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
    model_provenance: baselineModelProvenance(),
    ...overrides,
  };
}

function baselineVisualRecord(overrides = {}) {
  return baselineRecord({
    output_event: {
      id: 'output-visual-1',
      kind: 'render_target_hash',
      epoch: 'epoch-7',
      artifact_hash: HASH_B,
      process_id: 'pid-1',
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
    ...overrides,
  });
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
    abi_metadata: {
      kernel_abi_fingerprint_hashes: [HASH_C],
      extractor_sources: ['clang_ast'],
    },
    reload_mechanism: 'generated_adapter',
    adapter_outcome: 'adapter_generated',
    reload_evidence_refs: ['runtime:module-load'],
    firewall_evidence: {
      route: 'gpu_device_sidecar_reload',
      evidence_source: 'adversarial-self-check:reload-boundary',
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: 100,
      process_id_after: 100,
    },
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
      artifact_hash_before: HASH_A,
      artifact_hash_after: HASH_B,
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
    },
    hip_contract: {
      kernel_name: 'generic_kernel',
      launch_api: 'hipModuleLaunchKernel',
      grid_dim: [64, 1, 1],
      block_dim: [256, 1, 1],
      shared_mem_bytes: 0,
      stream: 'stream-1',
      kernel_params: [{ name: 'output', kind: 'device_pointer' }],
      code_object_metadata: {
        source: 'amd_code_object_metadata',
        args_hash: HASH_C,
      },
      output_buffers: ['allocation-1'],
      readback_oracle: {
        kind: 'buffer_checksum',
        schema_hash: HASH_C,
      },
    },
    ...overrides,
  };
}

function baselineFullRuntimeProof() {
  return {
    resultState: 'gpu-hmr-full-runtime-proven',
    fullRuntimeProven: true,
    stages: [
      'fission-candidate-verification',
      'compile',
      'symbol-binding',
      'abi',
      'artifact-transport',
      'epoch-swap',
      'dispatch-safe',
      'output',
      'artifact-identity',
      'host-preservation',
    ].map((stageId) => ({
      stageId,
      status: 'passed',
    })),
  };
}

function baselineProofComponents() {
  return {
    sourceProofs: [{
      resultState: 'gpu-hmr-symbol-bound',
      evidenceRefs: ['static:hip-launch'],
      proofArtifactPaths: ['memory://source-proof.json'],
    }],
    fissionProof: {
      fissionProven: true,
      selectedIslandContracts: [{
        islandId: 'device-kernel',
        sourcePaths: ['src/kernels/generic.hip'],
        artifactKind: 'hsaco',
        targetSymbols: ['generic_kernel'],
        compiler: 'hipcc',
        compileCommandHash: HASH_C,
        includeClosure: [],
      }],
      evidenceRefs: ['static:fission-contract'],
    },
    abiProof: {
      resultState: 'gpu-hmr-abi-proven',
      kernelAbiFingerprintHashes: [HASH_C],
      acceptedExtractorSources: ['clang_ast'],
      codeObjectMetadata: {
        source: 'amd_code_object_metadata',
        args_hash: HASH_C,
      },
      extractorProvenance: [{
        kind: 'clang_ast',
        evidenceId: 'static:clang-ast',
      }],
      evidenceRefs: ['code-object:metadata'],
    },
    artifactTransportProof: {
      resultState: 'gpu-hmr-artifact-transport-proven',
      ramTransportProven: true,
      selectedArtifactIds: [HASH_B],
      ramBlobIds: [HASH_B],
      processId: 'pid-1',
      eventId: 'load-1',
      timestampMonotonicNs: 100,
      evidenceRefs: ['runtime:module-load'],
    },
    epochProof: {
      resultState: 'gpu-hmr-epoch-swap-proven',
      published: true,
      activeEpoch: 'epoch-7',
      oldGenerationRetired: true,
      streamOrderingProven: true,
      retirementStrategy: 'stream_event',
      streamIds: ['stream-1'],
      eventId: 'publish-1',
      processId: 'pid-1',
      retirementEventId: 'retire-1',
      retirementFenceIds: ['runtime:stream-event'],
      epochGenerationGraph: {
        latestPublication: {
          id: 'publish-1',
          epoch: 'epoch-7',
          oldArtifactId: HASH_A,
          newArtifactId: HASH_B,
          publishTimestamp: 200,
        },
      },
      evidenceRefs: ['runtime:epoch-publish'],
    },
    dispatchProof: {
      resultState: 'gpu-hmr-dispatch-safe-proven',
      dispatchId: 'dispatch-1',
      epoch: 'epoch-7',
      selectedArtifactIds: [HASH_B],
      runtimeArtifactIds: [HASH_B],
      processId: 'pid-1',
      dispatchTimestamp: 300,
      dispatchStreamIds: ['stream-1'],
      dispatchTableEntryIds: ['generic_kernel:epoch-7'],
      kernelName: 'generic_kernel',
      launchApi: 'hipModuleLaunchKernel',
      gridDim: [64, 1, 1],
      blockDim: [256, 1, 1],
      sharedMemBytes: 0,
      kernelParams: [{ name: 'output', kind: 'device_pointer' }],
      argProvenanceRecords: [{
        category: 'device_allocation',
        allocationId: 'allocation-1',
      }],
      evidenceRefs: ['runtime:dispatch'],
    },
    outputProof: {
      resultState: 'gpu-hmr-output-oracle-proven',
      eventId: 'output-1',
      processId: 'pid-1',
      epoch: 'epoch-7',
      afterDispatchId: 'dispatch-1',
      outputTimestamp: 400,
      outputBuffers: ['allocation-1'],
      outputOracle: {
        kind: 'buffer_checksum',
        artifactId: HASH_B,
        processId: 'pid-1',
        dispatchId: 'dispatch-1',
        passed: true,
        readbackTimestamp: 400,
      },
      evidenceRefs: ['runtime:output-oracle'],
    },
    hostPreservationProof: {
      resultState: 'gpu-hmr-host-preservation-proven',
      processId: 'pid-1',
      evidenceRefs: ['runtime:host-preservation'],
    },
  };
}

function baselineVisualOutputProof(overrides = {}) {
  return {
    resultState: 'gpu-hmr-output-oracle-proven',
    eventId: 'output-visual-1',
    processId: 'pid-1',
    epoch: 'epoch-7',
    afterDispatchId: 'dispatch-1',
    outputTimestamp: 400,
    visualFrameObserved: true,
    visualEvidenceRequired: true,
    outputOracle: {
      kind: 'render_target_hash',
      artifactId: HASH_B,
      processId: 'pid-1',
      dispatchId: 'dispatch-1',
      passed: true,
      readbackTimestamp: 400,
      deterministicVisualMode: {
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
    },
    evidenceRefs: ['runtime:visual-output-oracle'],
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
  backend: 'hip',
  gpuArch: 'gfx1201',
  processId: 'pid-1',
  deviceUuid: 'device-1',
  contextHandle: 'hip-context-1',
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  firewallEvidence: {
    route: 'gpu_device_sidecar_reload',
    evidence_source: 'adversarial-self-check:reload-boundary',
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    process_id_before: 100,
    process_id_after: 100,
  },
  modelProvenance: baselineModelProvenance(),
  ...baselineProofComponents(),
  acceptanceContract: baselineContract(),
  proofLedgerRecord: baselineRecord(),
  fullRuntimeProof: baselineFullRuntimeProof(),
});
assert.equal(runtimeArtifact.proofLedger.gpuHmrSuccess, true);
assert.equal(runtimeArtifact.proofLedgerQuery.gpuHmrSuccess, true);
assert.equal(runtimeArtifact.gpuHmrSuccess, true);
assert.equal(runtimeArtifact.acceptanceContractEvaluation.accepted, true);

const rejectedBlankVisualArtifact = buildValidationRuntimeProofArtifact({
  workspaceSlug: 'adversarial-generic-project',
  backend: 'hip',
  gpuArch: 'gfx1201',
  processId: 'pid-1',
  deviceUuid: 'device-1',
  contextHandle: 'hip-context-1',
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  firewallEvidence: {
    route: 'gpu_device_sidecar_reload',
    evidence_source: 'adversarial-self-check:reload-boundary',
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    process_id_before: 100,
    process_id_after: 100,
  },
  modelProvenance: baselineModelProvenance(),
  ...baselineProofComponents(),
  outputProof: baselineVisualOutputProof({
    visualEvidenceRefs: ['memory://blank-frame.png'],
  }),
  acceptanceContract: baselineContract(),
  fullRuntimeProof: baselineFullRuntimeProof(),
  visualEvidenceRefs: ['memory://blank-frame.png'],
  visualEvidenceArtifacts: [{
    path: 'memory://blank-frame.png',
    visual_quality: 'gpu-hmr-visual-blank',
    accepted_as_visual_evidence: false,
  }],
});
assert.equal(rejectedBlankVisualArtifact.gpuHmrSuccess, false);
assert.ok(
  rejectedBlankVisualArtifact.limitations.some((limitation) =>
    limitation.stageId === 'visual-evidence'
    && limitation.degradedReason === 'visual_artifact_not_accepted'
  ),
  `blank visual artifact expected visual_artifact_not_accepted, got ${rejectedBlankVisualArtifact.limitations.map((l) => l.degradedReason).join(',')}`,
);

const rejectedSameFrameVisualArtifact = buildValidationRuntimeProofArtifact({
  workspaceSlug: 'adversarial-generic-project',
  backend: 'hip',
  gpuArch: 'gfx1201',
  processId: 'pid-1',
  deviceUuid: 'device-1',
  contextHandle: 'hip-context-1',
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  firewallEvidence: {
    route: 'gpu_device_sidecar_reload',
    evidence_source: 'adversarial-self-check:reload-boundary',
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    process_id_before: 100,
    process_id_after: 100,
  },
  modelProvenance: baselineModelProvenance(),
  ...baselineProofComponents(),
  outputProof: baselineVisualOutputProof({
    visualEvidenceRefs: ['memory://before.png', 'memory://after.png'],
    outputOracle: {
      ...baselineVisualOutputProof().outputOracle,
      visualOracleArtifacts: {
        before_image: 'memory://before.png',
        after_image: 'memory://after.png',
      },
    },
  }),
  acceptanceContract: baselineContract(),
  fullRuntimeProof: baselineFullRuntimeProof(),
  visualEvidenceRefs: ['memory://before.png', 'memory://after.png'],
  visualEvidenceArtifacts: [
    {
      path: 'memory://before.png',
      contentHash: HASH_B,
      visual_quality: 'gpu-hmr-visual-varied-frame',
      accepted_as_visual_evidence: true,
    },
    {
      path: 'memory://after.png',
      contentHash: HASH_B,
      visual_quality: 'gpu-hmr-visual-varied-frame',
      accepted_as_visual_evidence: true,
    },
  ],
});
assert.equal(rejectedSameFrameVisualArtifact.gpuHmrSuccess, false);
assert.ok(
  rejectedSameFrameVisualArtifact.limitations.some((limitation) =>
    limitation.stageId === 'visual-evidence'
    && limitation.degradedReason === 'visual_before_after_same_frame'
  ),
  `same-frame visual artifact expected visual_before_after_same_frame, got ${rejectedSameFrameVisualArtifact.limitations.map((l) => l.degradedReason).join(',')}`,
);

const summary = buildGpuHmrValidationProofSummary({
  workspaceSlug: 'adversarial-generic-project',
  proofLedger: acceptedLedger,
  acceptanceContract: baselineContract(),
  firewallEvidence: {
    route: 'gpu_device_sidecar_reload',
    evidence_source: 'adversarial-self-check:reload-boundary',
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    process_id_before: 100,
    process_id_after: 100,
  },
  runtimeProofArtifactRecords: [{
    path: 'memory://runtime-proof-artifact.json',
    firewallEvidence: {
      route: 'gpu_device_sidecar_reload',
      evidence_source: 'adversarial-self-check:reload-boundary',
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: 100,
      process_id_after: 100,
    },
    acceptanceContract: runtimeArtifact.acceptanceContract,
    acceptanceContractEvaluation: runtimeArtifact.acceptanceContractEvaluation,
    proofLedger: runtimeArtifact.proofLedger,
    proofLedgerQuery: runtimeArtifact.proofLedgerQuery,
    proofMaterial: runtimeArtifact.proofMaterial,
    fullRuntimeProven: runtimeArtifact.fullRuntimeProven,
    gpuHmrSuccess: runtimeArtifact.gpuHmrSuccess,
  }],
});
assert.equal(summary.gpu_hmr_success, true, JSON.stringify({
  limitations: summary.limitations,
  proofStates: summary.proof_states,
}, null, 2));
assert.equal(summary.proof_states.proof_ledger.gpu_hmr_success, true);
assert.equal(summary.proof_states.acceptance_contract.accepted, true);

assertGpuHmrProofLedgerSuccess(baselineVisualRecord());

const cases = [
  ['missing cpu hmr absence evidence', (() => {
    const record = baselineRecord();
    delete record.cpu_hmr_used;
    return record;
  })(), 'cpu_hmr_absence_evidence_missing'],
  ['missing full rebuild absence evidence', (() => {
    const record = baselineRecord();
    delete record.full_rebuild_used;
    return record;
  })(), 'full_rebuild_absence_evidence_missing'],
  ['missing process restart absence evidence', (() => {
    const record = baselineRecord();
    delete record.process_restarted;
    return record;
  })(), 'process_restart_absence_evidence_missing'],
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
  ['dispatch timestamp missing', baselineRecord({ dispatch_event: { id: 'dispatch-1', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-1' } }), 'dispatch_timestamp_missing'],
  ['output from stale dispatch', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-1', after_dispatch_id: 'dispatch-old', passed: true, timestamp_monotonic_ns: 400 } }), 'output_after_dispatch_id_mismatch'],
  ['output before dispatch', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-1', after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 250 } }), 'output_precedes_dispatch'],
  ['output oracle failed', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-1', after_dispatch_id: 'dispatch-1', passed: false, timestamp_monotonic_ns: 400 } }), 'output_oracle_not_passed'],
  ['output artifact missing', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', process_id: 'pid-1', after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 400 } }), 'output_artifact_hash_missing'],
  ['output epoch missing', baselineRecord({ output_event: { kind: 'buffer_checksum', artifact_hash: HASH_B, process_id: 'pid-1', after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 400 } }), 'output_epoch_missing'],
  ['output timestamp missing', baselineRecord({ output_event: { kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-1', after_dispatch_id: 'dispatch-1', passed: true } }), 'output_timestamp_missing'],
  ['visual without deterministic mode', baselineRecord({ output_event: { kind: 'render_target_hash', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-1', after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 400 } }), 'visual_output_without_deterministic_mode'],
  ['camera jitter visual diff', baselineVisualRecord({
    deterministic_visual_mode: {
      fixed_seed: true,
      frozen_camera: false,
      temporal_accumulation_disabled: true,
      taa_disabled: true,
      denoiser_disabled: true,
      fixed_resolution: true,
      fixed_swapchain_image_count: true,
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: true,
    },
  }), 'frozen_camera_unproven'],
  ['same frame recaptured after edit', baselineVisualRecord({
    deterministic_visual_mode: {
      fixed_seed: true,
      frozen_camera: true,
      temporal_accumulation_disabled: true,
      taa_disabled: true,
      denoiser_disabled: true,
      fixed_resolution: true,
      fixed_swapchain_image_count: true,
      frame_capture_after_epoch_dispatch: false,
      presentation_fence_or_frame_boundary: true,
    },
  }), 'frame_capture_after_epoch_dispatch_unproven'],
  ['async presentation pre-epoch frame capture', baselineVisualRecord({
    deterministic_visual_mode: {
      fixed_seed: true,
      frozen_camera: true,
      temporal_accumulation_disabled: true,
      taa_disabled: true,
      denoiser_disabled: true,
      fixed_resolution: true,
      fixed_swapchain_image_count: true,
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: false,
    },
  }), 'presentation_boundary_unproven'],
  ['temporal convergence without sampled frames', baselineVisualRecord({
    deterministic_visual_mode: {
      seed_policy_fixed: true,
      frozen_camera: true,
      temporal_accumulation_present: true,
      taa_present: true,
      denoiser_present: true,
      fixed_resolution: true,
      fixed_swapchain_image_count: true,
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: true,
      convergence_window: {
        frame_start: 3,
        frame_end: 9,
        metric: { value: 'window_mean_delta' },
        metric_delta: 18.5,
        convergence_proven: true,
        evidence_refs: ['visual-window:post-epoch-frames'],
      },
    },
  }), 'convergence_window_sample_evidence_missing'],
  ['temporal convergence without fixed seed policy', baselineVisualRecord({
    deterministic_visual_mode: {
      frozen_camera: true,
      temporal_accumulation_present: true,
      taa_present: true,
      denoiser_present: true,
      fixed_resolution: true,
      fixed_swapchain_image_count: true,
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: true,
      convergence_window: {
        frame_start: 3,
        frame_end: 4,
        metric: { value: 'per_frame_delta' },
        samples: [
          { frame: 3, metric_value: 12.5, after_epoch_dispatch: true },
          { frame: 4, metric_value: 14.0, after_epoch_dispatch: true },
        ],
        convergence_proven: true,
        evidence_refs: ['visual-window:post-epoch-frames'],
      },
    },
  }), 'seed_policy_unproven'],
  ['missing model provenance', (() => {
    const record = baselineRecord();
    delete record.model_provenance;
    return record;
  })(), 'model_provenance_missing'],
  ['shutdown delta model provenance', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: {
        provider: 'google_gemini',
        requested_model: 'gemini-3.1-flash-lite-preview',
        provider_model_status: 'shutdown',
        provider_model_alias_resolved_to: null,
        provider_shutdown_or_deprecation_detected: true,
        model_availability_checked_at: '2026-06-07T00:00:00.000Z',
        actual_model: null,
        fallback_model: null,
        fallback_used: false,
        request_mode: 'gpu_delta',
        hard_infra_failure: true,
      },
    }),
  }), 'model_provider_status_shutdown'],
  ['missing model availability check time', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: (() => {
        const model = { ...baselineModelProvenance().last_gpu_delta };
        delete model.model_availability_checked_at;
        return model;
      })(),
    }),
  }), 'model_availability_checked_at_missing'],
  ['missing process identity', baselineRecord({ process_identity: {} }), 'process_identity_missing'],
  ['loader process identity missing', baselineRecord({ loader_event: { id: 'load-1', artifact_hash: HASH_B, timestamp_monotonic_ns: 100 } }), 'loader_process_identity_missing'],
  ['loader process mismatch', baselineRecord({ loader_event: { id: 'load-1', artifact_hash: HASH_B, process_id: 'pid-2', timestamp_monotonic_ns: 100 } }), 'loader_process_identity_mismatch'],
  ['epoch publish process identity missing', baselineRecord({ epoch_publish_event: { id: 'publish-1', epoch: 'epoch-7', artifact_hash: HASH_B, timestamp_monotonic_ns: 200 } }), 'epoch_publish_process_identity_missing'],
  ['epoch publish process mismatch', baselineRecord({ epoch_publish_event: { id: 'publish-1', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-2', timestamp_monotonic_ns: 200 } }), 'epoch_publish_process_identity_mismatch'],
  ['dispatch process identity missing', baselineRecord({ dispatch_event: { id: 'dispatch-1', epoch: 'epoch-7', artifact_hash: HASH_B, timestamp_monotonic_ns: 300 } }), 'dispatch_process_identity_missing'],
  ['output process identity missing', baselineRecord({ output_event: { id: 'output-1', kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 400 } }), 'output_process_identity_missing'],
  ['output process mismatch', baselineRecord({ output_event: { id: 'output-1', kind: 'buffer_checksum', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-2', after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 400 } }), 'output_process_identity_mismatch'],
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

const forgedSuccessFlagLedger = buildGpuHmrProofLedger(baselineRecord({ cpu_hmr_used: true }));
forgedSuccessFlagLedger.gpuHmrSuccess = true;
forgedSuccessFlagLedger.gpu_hmr_success = true;
const forgedSuccessFlagResult = queryGpuHmrLedgerInvariants(forgedSuccessFlagLedger);
assert.equal(forgedSuccessFlagResult.gpuHmrSuccess, false);
assert.ok(
  forgedSuccessFlagResult.failedInvariants.some((failure) => failure.code === 'ledger_success_flag_mismatch'),
  `forged top-level success flag expected ledger_success_flag_mismatch, got ${forgedSuccessFlagResult.failedInvariants.map((f) => f.code).join(',')}`,
);

const forgedProofIdLedger = buildGpuHmrProofLedger(baselineRecord());
forgedProofIdLedger.proofId = 'gpu-ledger-proof:sha256:forged';
const forgedProofIdResult = queryGpuHmrLedgerInvariants(forgedProofIdLedger);
assert.equal(forgedProofIdResult.gpuHmrSuccess, false);
assert.ok(
  forgedProofIdResult.failedInvariants.some((failure) => failure.code === 'ledger_proof_id_mismatch'),
  `forged proof id expected ledger_proof_id_mismatch, got ${forgedProofIdResult.failedInvariants.map((f) => f.code).join(',')}`,
);

const unversionedQueryLedger = buildGpuHmrProofLedger(baselineRecord());
unversionedQueryLedger.query = { gpuHmrSuccess: true, failedInvariants: [] };
const unversionedQueryResult = queryGpuHmrLedgerInvariants(unversionedQueryLedger);
assert.equal(unversionedQueryResult.gpuHmrSuccess, false);
assert.ok(
  unversionedQueryResult.failedInvariants.some((failure) => failure.code === 'supplied_ledger_query_schema_mismatch'),
  `unversioned query expected supplied_ledger_query_schema_mismatch, got ${unversionedQueryResult.failedInvariants.map((f) => f.code).join(',')}`,
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
