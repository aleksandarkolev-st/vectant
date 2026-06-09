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
const REQUIRED_TIMING_FIELDS = [
  'static_discovery_time',
  'ai_contract_synthesis_time',
  'model_availability_check_time',
  'artifact_hash_time',
  'adapter_generation_time',
  'device_compile_wall_time',
  'artifact_load_time',
  'epoch_publish_time',
  'dispatch_trace_time',
  'runtime_probe_time',
  'oracle_analysis_time',
  'trigger_to_visible_time',
  'screenshot_capture_time',
  'dispatch_to_output_proof_time',
  'total_validator_wall_time',
];
const MODEL_AVAILABILITY_SOURCE = 'https://ai.google.dev/gemini-api/docs/deprecations';

function modelAvailabilityFields({
  basis = 'static_registry',
  checkTimeMs = 0,
} = {}) {
  return {
    model_availability_source: MODEL_AVAILABILITY_SOURCE,
    model_availability_basis: basis,
    model_availability_check_time_ms: checkTimeMs,
  };
}

function baselineModelProvenance(overrides = {}) {
  return {
    split: {
      provider: 'google_gemini',
      requested_model: 'gemini-3.5-flash',
      provider_model_status: 'available',
      provider_model_alias_resolved_to: null,
      provider_shutdown_or_deprecation_detected: false,
      model_availability_checked_at: '2026-06-07T00:00:00.000Z',
      ...modelAvailabilityFields(),
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
      ...modelAvailabilityFields(),
      actual_model: 'gemini-3.1-flash-lite',
      fallback_model: null,
      fallback_used: false,
      request_mode: 'gpu_delta',
      hard_infra_failure: false,
    },
    ...overrides,
  };
}

function baselineComputeOracleArtifacts(overrides = {}) {
  return {
    raw_readback_bin: 'memory://readback-after.bin',
    readback_schema_json: 'memory://readback-schema.json',
    checksum_before: HASH_A,
    checksum_after: HASH_B,
    expected_output_change: true,
    deterministic_slice: {
      offset: 0,
      length: 64,
      format: 'float32',
      hash: HASH_C,
    },
    raw_readback_hash: HASH_B,
    raw_readback_hash_verified: true,
    raw_readback_byte_length: 128,
    raw_readback_source: 'runtime_readback_sample',
    deterministic_slice_hash: HASH_C,
    deterministic_slice_hash_verified: true,
    raw_readback_verification: {
      hash_verified: true,
      byte_length: 128,
      deterministic_slice_hash: HASH_C,
      deterministic_slice_hash_verified: true,
      slice_bounds_verified: true,
    },
    oracle_code_hash: HASH_C,
    rendered_card_png: 'memory://compute-oracle-card.png',
    producer: 'adversarial-ledger-self-check',
    timestamp_after_dispatch: 400,
    epoch: 'epoch-7',
    ...overrides,
  };
}

function baselineVisualOracleArtifacts(overrides = {}) {
  return {
    before_image: 'memory://visual-before.png',
    after_image: 'memory://visual-after.png',
    diff_image: 'memory://visual-diff.png',
    blank_frame_rejection: true,
    same_frame_rejection: true,
    new_epoch_watermark_or_trace: 'dispatch-1:epoch-7',
    camera_state_hash: HASH_C,
    swapchain_size: [640, 480],
    capture_backend: 'mcp_screenshot',
    frame_number: 12,
    timestamp_after_dispatch: 400,
    perceptual_diff: 0.42,
    changed_pixel_ratio: 0.25,
    visible_pixel_count: 1024,
    before_image_hash: HASH_A,
    after_image_hash: HASH_B,
    diff_image_hash: HASH_C,
    before_image_hash_verified: true,
    after_image_hash_verified: true,
    diff_image_hash_verified: true,
    pixel_metrics_verified: true,
    visual_pixel_verification: {
      before_image_hash: HASH_A,
      after_image_hash: HASH_B,
      diff_image_hash: HASH_C,
      before_image_hash_verified: true,
      after_image_hash_verified: true,
      diff_image_hash_verified: true,
      metrics_verified: true,
      changed_pixel_ratio_recomputed: 0.25,
      perceptual_diff_recomputed: 0.42,
      visible_pixel_count_recomputed: 1024,
    },
    ...overrides,
  };
}

function baselineTimingMetrics(overrides = {}) {
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
    ...overrides,
  };
}

function baselineClassification(overrides = {}) {
  return {
    project_kind: 'gpu_project',
    edit_kind: 'gpu_artifact_edit',
    route: 'gpu_hmr',
    confidence: 0.95,
    blocking_gaps: [],
    ...overrides,
  };
}

function baselineRecord(overrides = {}) {
  return {
    project_id: 'adversarial-generic-project',
    edit_id: 'gpu-artifact-edit',
    backend: 'hip',
    classification: baselineClassification(),
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
      timestamp_monotonic_ns: 500,
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
    oracle_artifacts: {
      compute_oracle_artifacts: baselineComputeOracleArtifacts(),
    },
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'compiler_cache_warm',
    timings: baselineTimingMetrics(),
    model_provenance: baselineModelProvenance(),
    evidence_refs: ['runtime:module-load', 'runtime:epoch-publish', 'runtime:dispatch', 'runtime:output-oracle'],
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
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts(),
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
    classification: baselineClassification(),
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
      args: [{
        name: 'output',
        type: 'float*',
        size: 8,
        offset: 0,
        value_kind: 'device_pointer',
        access: 'write',
        address_space: 'global',
        source: 'code_object',
      }],
      workgroup_or_launch_shape: {
        grid_dim: [64, 1, 1],
        block_dim: [256, 1, 1],
        shared_mem_bytes: 0,
      },
      stream_or_queue_requirements: {
        stream: 'stream-1',
      },
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
      changed_sources: ['src/kernels/generic.hip'],
      included_dependencies: [],
      excluded_host_sources: [],
      artifact_hash_before: HASH_A,
      artifact_hash_after: HASH_B,
      abi_compatibility_class: 'compatible',
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
      unaffected_artifacts_hash_unchanged: true,
      selected_verifier_evidence_id: 'fission-candidate:device-kernel:verified',
      deterministic_verifier_evidence_refs: ['static:fission-source-map'],
      selection_decision_hash: HASH_C,
      output_oracle_contract: {
        kind: 'buffer_checksum',
        output_target_id: 'allocation-1',
        readback_plan: 'after-dispatch',
      },
      evidence_refs: ['evidence:fission-verifier-report:adversarial-self-check', 'runtime:module-load'],
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
        artifactId: HASH_B,
        processId: 'pid-1',
        dispatchId: 'dispatch-1',
        readbackTimestamp: 400,
      },
      field_evidence_refs: {
        kernel_name: ['runtime:dispatch'],
        launch_api: ['runtime:dispatch'],
        grid_dim: ['runtime:dispatch'],
        block_dim: ['runtime:dispatch'],
        shared_mem_bytes: ['runtime:dispatch'],
        stream: ['runtime:dispatch'],
        kernel_params: ['runtime:dispatch'],
        code_object_metadata: ['code-object:metadata'],
        output_buffers: ['runtime:output-oracle'],
        readback_oracle: ['runtime:output-oracle'],
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

function baselineRuntimeMetricInput() {
  return {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    timings: baselineTimingMetrics(),
    adversarialPreflight: baselineAdversarialPreflight(),
  };
}

function baselineAdversarialPreflight(overrides = {}) {
  return {
    schemaVersion: 'synthi.gpu_hmr.adversarial_preflight.v1',
    ok: true,
    skipped: false,
    scriptPath: '/workspace/mcp/synthi-mcp/scripts/gpu-hmr-adversarial-proof-ledger-self-check.mjs',
    exitCode: 0,
    elapsedMs: 42.5,
    stdoutHash: `sha256:${'8'.repeat(64)}`,
    stderrHash: `sha256:${'0'.repeat(64)}`,
    stdoutTail: 'GPU HMR adversarial proof ledger self-check passed',
    stderrTail: '',
    error: null,
    ...overrides,
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
        verifierEvidenceId: 'fission-candidate:device-kernel:verified',
        deterministicVerifierEvidenceIds: ['static:fission-source-map'],
        outputOracleContract: {
          kind: 'buffer_checksum',
          outputTargetId: 'allocation-1',
          readbackPlan: 'after-dispatch',
        },
      }],
      verifierEvidenceRefs: ['fission-candidate:device-kernel:verified'],
      deterministicVerifierEvidenceRefs: ['static:fission-source-map'],
      evidenceRefs: ['evidence:fission-verifier-report:adversarial-self-check'],
    },
    abiProof: {
      resultState: 'gpu-hmr-abi-proven',
      abiCompatibilityClass: 'compatible',
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
assert.equal(assertGpuHmrProofLedgerSuccess(baselineRecord({
  metric_clock: null,
  metric_scope: null,
  cache_state: null,
  timings: {
    timingMetrics: baselineTimingMetrics(),
  },
})).gpuHmrSuccess, true);
assert.equal(assertGpuHmrProofLedgerSuccess(baselineRecord({
  backend: 'vulkan',
  output_oracle_target: {
    kind: 'compute',
    target_id: 'compute-target:validation-buffer',
    compute_only_target_verified: true,
    evidence_refs: ['oracle-target:compute-only:validation-buffer'],
  },
})).gpuHmrSuccess, true);

const acceptedLedger = buildGpuHmrProofLedger(baselineRecord());
const runtimeArtifact = buildValidationRuntimeProofArtifact({
  workspaceSlug: 'adversarial-generic-project',
  sourceEditId: 'gpu-artifact-edit',
  ...baselineRuntimeMetricInput(),
  backend: 'hip',
  gpuArch: 'gfx1201',
  processId: 'pid-1',
  deviceUuid: 'device-1',
  contextHandle: 'hip-context-1',
  classification: baselineClassification(),
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
  computeOracleArtifacts: baselineComputeOracleArtifacts(),
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
  sourceEditId: 'gpu-artifact-edit',
  ...baselineRuntimeMetricInput(),
  backend: 'hip',
  gpuArch: 'gfx1201',
  processId: 'pid-1',
  deviceUuid: 'device-1',
  contextHandle: 'hip-context-1',
  classification: baselineClassification(),
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
  sourceEditId: 'gpu-artifact-edit',
  ...baselineRuntimeMetricInput(),
  backend: 'hip',
  gpuArch: 'gfx1201',
  processId: 'pid-1',
  deviceUuid: 'device-1',
  contextHandle: 'hip-context-1',
  classification: baselineClassification(),
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

const forgedDispatchLedgerRecord = baselineRecord({
  dispatch_event: {
    id: 'dispatch-forged',
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
    after_dispatch_id: 'dispatch-forged',
    passed: true,
    timestamp_monotonic_ns: 400,
  },
});
assert.equal(evaluateGpuHmrProofLedger(forgedDispatchLedgerRecord).gpuHmrSuccess, true);
const rejectedForgedExplicitLedgerArtifact = buildValidationRuntimeProofArtifact({
  workspaceSlug: 'adversarial-generic-project',
  sourceEditId: 'gpu-artifact-edit',
  ...baselineRuntimeMetricInput(),
  backend: 'hip',
  gpuArch: 'gfx1201',
  processId: 'pid-1',
  deviceUuid: 'device-1',
  contextHandle: 'hip-context-1',
  classification: baselineClassification(),
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
  proofLedgerRecord: forgedDispatchLedgerRecord,
  fullRuntimeProof: baselineFullRuntimeProof(),
});
assert.equal(rejectedForgedExplicitLedgerArtifact.gpuHmrSuccess, false);
assert.equal(
  rejectedForgedExplicitLedgerArtifact.proofLedgerSourceConsistency.accepted,
  false,
);
assert.ok(
  rejectedForgedExplicitLedgerArtifact.limitations.some((limitation) =>
    limitation.stageId === 'proof-ledger-source-consistency'
    && limitation.degradedReason === 'proof_ledger_source_dispatch_event_id_mismatch'
  ),
  `forged explicit ledger expected dispatch_event_id_mismatch, got ${rejectedForgedExplicitLedgerArtifact.limitations.map((l) => l.degradedReason).join(',')}`,
);

const summary = buildGpuHmrValidationProofSummary({
  workspaceSlug: 'adversarial-generic-project',
  proofLedger: acceptedLedger,
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
    classification: baselineClassification(),
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
  ['unknown project kind classification', baselineRecord({
    classification: { project_kind: 'unknown', edit_kind: 'gpu_artifact_edit', route: 'gpu_hmr' },
  }), 'classification_project_kind_not_gpu_hmr'],
  ['mixed host gpu edit classification', baselineRecord({
    classification: { project_kind: 'mixed_project', edit_kind: 'mixed_host_gpu', route: 'gpu_hmr' },
  }), 'classification_edit_kind_not_gpu_artifact'],
  ['cpu fallback', baselineRecord({ cpu_hmr_used: true }), 'cpu_hmr_used'],
  ['full rebuild', baselineRecord({ full_rebuild_used: true }), 'full_rebuild_used'],
  ['process restart', baselineRecord({ process_restarted: true }), 'process_restarted'],
  ['firewall process identity contradiction', baselineRecord({
    firewall_evidence: {
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: 'pid-1',
      process_id_after: 'pid-2',
    },
  }), 'firewall_process_identity_contradiction'],
  ['missing project id', baselineRecord({ project_id: null }), 'project_id_missing'],
  ['missing edit id', baselineRecord({ edit_id: null }), 'edit_id_missing'],
  ['missing backend', baselineRecord({ backend: null }), 'backend_missing'],
  ['unsupported backend', baselineRecord({ backend: 'unknown' }), 'backend_unsupported'],
  ['missing ledger evidence refs', baselineRecord({ evidence_refs: [] }), 'evidence_refs_missing'],
  ['missing metric clock', baselineRecord({
    metric_clock: null,
    timings: baselineTimingMetrics({ metric_clock: null }),
  }), 'metric_clock_missing'],
  ['wall clock metric rejected', baselineRecord({
    metric_clock: 'wall_ms',
  }), 'metric_clock_not_monotonic_ns'],
  ['missing metric scope', baselineRecord({
    metric_scope: null,
    timings: baselineTimingMetrics({ metric_scope: null }),
  }), 'metric_scope_missing'],
  ['unsupported metric scope', baselineRecord({ metric_scope: 'unknown' }), 'metric_scope_unsupported'],
  ['missing cache state', baselineRecord({
    cache_state: null,
    timings: baselineTimingMetrics({ cache_state: null }),
  }), 'cache_state_missing'],
  ['unsupported cache state', baselineRecord({ cache_state: 'unknown' }), 'cache_state_unsupported'],
  ['missing timings object', baselineRecord({ timings: {} }), 'timings_missing'],
  ...REQUIRED_TIMING_FIELDS.map((field) => [
    `missing ${field} timing`,
    baselineRecord({
      timings: baselineTimingMetrics({ [field]: null }),
    }),
    `timing_${field}_missing`,
  ]),
  ['missing split model provenance role', baselineRecord({
    model_provenance: {
      last_gpu_delta: baselineModelProvenance().last_gpu_delta,
    },
  }), 'model_provenance_split_missing'],
  ['missing gpu delta model provenance role', baselineRecord({
    model_provenance: {
      split: baselineModelProvenance().split,
    },
  }), 'model_provenance_gpu_delta_missing'],
  ['gpu delta model fallback used', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: {
        ...baselineModelProvenance().last_gpu_delta,
        actual_model: 'gemini-3.5-flash',
        fallback_model: 'gemini-3.5-flash',
        fallback_used: true,
        actual_provider_model_status: 'available',
        actual_model_availability_checked_at: '2026-06-07T00:00:00.000Z',
        fallback_provider_model_status: 'available',
        fallback_model_availability_checked_at: '2026-06-07T00:00:00.000Z',
      },
    }),
  }), 'gpu_delta_model_fallback_used'],
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
  ['missing compute oracle artifacts', (() => {
    const record = baselineRecord();
    delete record.oracle_artifacts;
    return record;
  })(), 'compute_oracle_artifacts_missing'],
  ['incomplete compute oracle artifacts', baselineRecord({
    oracle_artifacts: {
      compute_oracle_artifacts: {
        ...baselineComputeOracleArtifacts(),
        raw_readback_bin: null,
      },
    },
  }), 'compute_oracle_artifacts_incomplete'],
  ['unchanged compute oracle checksum', baselineRecord({
    oracle_artifacts: {
      compute_oracle_artifacts: baselineComputeOracleArtifacts({ checksum_after: HASH_A }),
    },
  }), 'compute_oracle_checksum_unchanged'],
  ['missing compute raw readback proof', baselineRecord({
    oracle_artifacts: {
      compute_oracle_artifacts: baselineComputeOracleArtifacts({
        raw_readback_hash: null,
        raw_readback_source: null,
      }),
    },
  }), 'compute_oracle_raw_readback_unproven'],
  ['unverified compute raw readback bytes', baselineRecord({
    oracle_artifacts: {
      compute_oracle_artifacts: baselineComputeOracleArtifacts({
        raw_readback_hash_verified: false,
        raw_readback_verification: null,
      }),
    },
  }), 'compute_oracle_raw_readback_hash_unverified'],
  ['out-of-bounds compute deterministic slice', baselineRecord({
    oracle_artifacts: {
      compute_oracle_artifacts: baselineComputeOracleArtifacts({
        deterministic_slice: {
          offset: 96,
          length: 64,
          format: 'float32',
          hash: HASH_C,
        },
      }),
    },
  }), 'compute_oracle_deterministic_slice_out_of_bounds'],
  ['digest-derived compute raw readback proof', baselineRecord({
    oracle_artifacts: {
      compute_oracle_artifacts: baselineComputeOracleArtifacts({
        raw_readback_source: 'runtime_checksum_digest',
        deterministic_slice: {
          offset: 0,
          length: 64,
          format: 'float32',
          source: 'runtime_checksum_digest',
        },
      }),
    },
  }), 'compute_oracle_raw_readback_digest_derived'],
  ['unaccepted compute raw readback source', baselineRecord({
    oracle_artifacts: {
      compute_oracle_artifacts: baselineComputeOracleArtifacts({
        raw_readback_source: 'unit_test_fixture',
      }),
    },
  }), 'compute_oracle_raw_readback_source_unaccepted'],
  ['visual backend with compute oracle rejected', baselineRecord({
    backend: 'hiprt',
  }), 'visual_backend_requires_visual_oracle'],
  ['visual backend compute target without proof rejected', baselineRecord({
    backend: 'vulkan',
    output_oracle_target: {
      kind: 'compute',
      target_id: 'compute-target:unverified',
    },
  }), 'visual_backend_compute_target_unverified'],
  ['visual without deterministic mode', baselineRecord({ output_event: { kind: 'render_target_hash', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-1', after_dispatch_id: 'dispatch-1', passed: true, timestamp_monotonic_ns: 400 } }), 'visual_output_without_deterministic_mode'],
  ['missing visual oracle artifacts', baselineVisualRecord({ oracle_artifacts: {} }), 'visual_oracle_artifacts_missing'],
  ['incomplete visual oracle artifacts', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: {
        ...baselineVisualOracleArtifacts(),
        diff_image: null,
      },
    },
  }), 'visual_oracle_artifacts_incomplete'],
  ['visual pixel metrics unverified', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({
        pixel_metrics_verified: false,
        visual_pixel_verification: null,
      }),
    },
  }), 'visual_pixel_metrics_unverified'],
  ['visual blank frame rejection not proven', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({ blank_frame_rejection: false }),
    },
  }), 'visual_blank_frame_rejection_not_proven'],
  ['visual same frame rejection not proven', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({ same_frame_rejection: false }),
    },
  }), 'visual_same_frame_rejection_not_proven'],
  ['visual before after same artifact', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({
        before_image: 'memory://same-frame.png',
        after_image: 'memory://same-frame.png',
      }),
    },
  }), 'visual_before_after_same_artifact'],
  ['visual diff artifact not independent', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({
        diff_image: 'memory://visual-after.png',
      }),
    },
  }), 'visual_diff_artifact_not_independent'],
  ['visual zero changed pixels', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({ changed_pixel_ratio: 0 }),
    },
  }), 'visual_changed_pixel_ratio_zero'],
  ['visual zero perceptual diff', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({ perceptual_diff: 0 }),
    },
  }), 'visual_perceptual_diff_zero'],
  ['visual zero visible pixels', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({ visible_pixel_count: 0 }),
    },
  }), 'visual_visible_pixel_count_zero'],
  ['visual invalid swapchain size', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({ swapchain_size: [640, 0] }),
    },
  }), 'visual_swapchain_size_invalid'],
  ['visual artifact before dispatch', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({ timestamp_after_dispatch: 250 }),
    },
  }), 'visual_artifact_precedes_dispatch'],
  ['visual epoch trace unrelated', baselineVisualRecord({
    oracle_artifacts: {
      visual_oracle_artifacts: baselineVisualOracleArtifacts({
        new_epoch_watermark_or_trace: 'unrelated-render-trace',
      }),
    },
  }), 'visual_epoch_trace_not_correlated'],
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
  ['temporal visual without fixed seed policy or convergence proof', baselineVisualRecord({
    deterministic_visual_mode: {
      frozen_camera: true,
      temporal_accumulation_present: true,
      taa_present: true,
      denoiser_present: true,
      fixed_resolution: true,
      fixed_swapchain_image_count: true,
      frame_capture_after_epoch_dispatch: true,
      presentation_fence_or_frame_boundary: true,
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
  ['non-Gemini split provider provenance', baselineRecord({
    model_provenance: baselineModelProvenance({
      split: {
        ...baselineModelProvenance().split,
        provider: 'anthropic',
      },
    }),
  }), 'model_provider_not_allowed'],
  ['wrong split model provenance', baselineRecord({
    model_provenance: baselineModelProvenance({
      split: {
        ...baselineModelProvenance().split,
        requested_model: 'gpt-image-2',
        actual_model: 'gpt-image-2',
      },
    }),
  }), 'model_requested_model_unexpected'],
  ['wrong delta model provenance', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: {
        ...baselineModelProvenance().last_gpu_delta,
        requested_model: 'gemini-3.5-flash',
        actual_model: 'gemini-3.5-flash',
      },
    }),
  }), 'model_requested_model_unexpected'],
  ['unresolved private delta alias provenance', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: {
        ...baselineModelProvenance().last_gpu_delta,
        requested_model: 'internal-fast-delta',
        actual_model: 'internal-fast-delta',
        provider_model_status: 'private_alias',
        provider_model_alias_resolved_to: null,
      },
    }),
  }), 'model_private_alias_unresolved'],
  ['missing model availability check time', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: (() => {
        const model = { ...baselineModelProvenance().last_gpu_delta };
        delete model.model_availability_checked_at;
        return model;
      })(),
    }),
  }), 'model_availability_checked_at_missing'],
  ['missing model availability source', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: (() => {
        const model = { ...baselineModelProvenance().last_gpu_delta };
        delete model.model_availability_source;
        return model;
      })(),
    }),
  }), 'model_availability_source_missing'],
  ['untrusted model availability source', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: {
        ...baselineModelProvenance().last_gpu_delta,
        model_availability_source: 'provider_not_checked',
      },
    }),
  }), 'model_availability_source_untrusted'],
  ['private alias without provider-backed basis', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: {
        ...baselineModelProvenance().last_gpu_delta,
        requested_model: 'internal-fast-delta',
        actual_model: 'internal-fast-delta',
        provider_model_status: 'private_alias',
        provider_model_alias_resolved_to: 'gemini-3.1-flash-lite',
        model_availability_basis: 'static_registry',
      },
    }),
  }), 'model_private_alias_basis_unproven'],
  ['fallback missing actual provider status', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: {
        ...baselineModelProvenance().last_gpu_delta,
        actual_model: 'gemini-3.5-flash',
        fallback_model: 'gemini-3.5-flash',
        fallback_used: true,
      },
    }),
  }), 'actual_provider_model_status_missing'],
  ['fallback actual provider status shutdown', baselineRecord({
    model_provenance: baselineModelProvenance({
      last_gpu_delta: {
        ...baselineModelProvenance().last_gpu_delta,
        actual_model: 'gemini-3.5-flash',
        fallback_model: 'gemini-3.5-flash',
        fallback_used: true,
        actual_provider_model_status: 'shutdown',
        actual_model_availability_checked_at: '2026-06-07T00:00:00.000Z',
        fallback_provider_model_status: 'available',
        fallback_model_availability_checked_at: '2026-06-07T00:00:00.000Z',
      },
    }),
  }), 'actual_model_provider_status_shutdown'],
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
  ['missing retirement proof', baselineRecord({ retirement_event: { id: 'retire-1', epoch: 'epoch-6', timestamp_monotonic_ns: 500 } }), 'retirement_proof_missing'],
  ['epoch publish before load', baselineRecord({ epoch_publish_event: { id: 'publish-1', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-1', timestamp_monotonic_ns: 50 } }), 'epoch_publish_precedes_loader'],
  ['dispatch before epoch publish', baselineRecord({ dispatch_event: { id: 'dispatch-1', epoch: 'epoch-7', artifact_hash: HASH_B, process_id: 'pid-1', timestamp_monotonic_ns: 150 } }), 'dispatch_precedes_epoch_publish'],
  ['retirement before output', baselineRecord({ retirement_event: { id: 'retire-1', epoch: 'epoch-6', proof: 'no_retirement_required', timestamp_monotonic_ns: 350 } }), 'retirement_precedes_output'],
  ['missing retirement timestamp', baselineRecord({ retirement_event: { id: 'retire-1', epoch: 'epoch-6', proof: 'no_retirement_required' } }), 'retirement_timestamp_missing'],
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

const forgedRecordProofIdLedger = buildGpuHmrProofLedger(baselineRecord());
forgedRecordProofIdLedger.records[0].proofId = 'gpu-ledger-proof:sha256:forged';
const forgedRecordProofIdResult = queryGpuHmrLedgerInvariants(forgedRecordProofIdLedger);
assert.equal(forgedRecordProofIdResult.gpuHmrSuccess, false);
assert.ok(
  forgedRecordProofIdResult.failedInvariants.some((failure) => failure.code === 'record_proof_id_mismatch'),
  `forged record proof id expected record_proof_id_mismatch, got ${forgedRecordProofIdResult.failedInvariants.map((f) => f.code).join(',')}`,
);

const hiddenBadHistoryLedger = {
  schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
  records: [
    buildGpuHmrProofLedger(baselineRecord({ cpu_hmr_used: true })).records[0],
    buildGpuHmrProofLedger(baselineRecord({ edit_id: 'edit-history-2' })).records[0],
  ],
  gpuHmrSuccess: true,
};
const hiddenBadHistoryResult = queryGpuHmrLedgerInvariants(hiddenBadHistoryLedger);
assert.equal(hiddenBadHistoryResult.gpuHmrSuccess, false);
assert.ok(
  hiddenBadHistoryResult.failedInvariants.some((failure) =>
    failure.code === 'cpu_hmr_used' && failure.record_index === 0
  ),
  `hidden bad history expected cpu_hmr_used on record 0, got ${hiddenBadHistoryResult.failedInvariants.map((f) => `${f.code}:${f.record_index ?? ''}`).join(',')}`,
);

const historyFirst = buildGpuHmrProofLedger(baselineRecord({ edit_id: 'edit-history-root-1' })).records[0];
const historyLast = buildGpuHmrProofLedger(baselineRecord({ edit_id: 'edit-history-root-2' })).records[0];
const lastRecordOnlyProofLedger = {
  schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
  proofId: historyLast.proofId,
  records: [historyFirst, historyLast],
  gpuHmrSuccess: true,
};
const lastRecordOnlyProofResult = queryGpuHmrLedgerInvariants(lastRecordOnlyProofLedger);
assert.equal(lastRecordOnlyProofResult.gpuHmrSuccess, false);
assert.ok(
  lastRecordOnlyProofResult.failedInvariants.some((failure) => failure.code === 'ledger_proof_id_mismatch'),
  `last-record-only proof expected ledger_proof_id_mismatch, got ${lastRecordOnlyProofResult.failedInvariants.map((f) => f.code).join(',')}`,
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
