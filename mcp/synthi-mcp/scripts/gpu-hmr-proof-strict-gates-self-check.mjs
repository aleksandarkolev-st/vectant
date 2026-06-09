#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  adversarialPreflightStrictGate,
  runtimeProofArtifactStrictGate,
  runtimeProofArtifactStrictGates,
  strictProofGateFailures,
} from './lib/gpu-hmr-proof-strict-gates.mjs';
import { buildGpuHmrProofLedger } from './lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
} from './lib/gpu-hmr-acceptance-contract.mjs';

const HASH_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const MODEL_AVAILABILITY_SOURCE = 'https://ai.google.dev/gemini-api/docs/deprecations';

function modelAvailabilityFields() {
  return {
    model_availability_source: MODEL_AVAILABILITY_SOURCE,
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 0,
  };
}

const passingPreflight = {
  ok: true,
  skipped: false,
  exitCode: 0,
  scriptPath: '/tmp/gpu-hmr-adversarial-proof-ledger-self-check.mjs',
  elapsedMs: 12.3,
  stdoutHash: 'sha256:0'.padEnd(71, '0'),
  stderrHash: 'sha256:0'.padEnd(71, '0'),
  error: null,
};

function modelProvenance() {
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
    gpu_delta: {
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
  };
}

function computeOracleArtifacts() {
  return {
    raw_readback_bin: 'memory://strict-readback-after.bin',
    readback_schema_json: 'memory://strict-readback-schema.json',
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
    rendered_card_png: 'memory://strict-compute-oracle-card.png',
    producer: 'strict-gates-self-check',
    timestamp_after_dispatch: 400,
    epoch: 'epoch-7',
  };
}

function deterministicVisualMode() {
  return {
    fixed_seed: true,
    frozen_camera: true,
    temporal_accumulation_disabled: true,
    taa_disabled: true,
    denoiser_disabled: true,
    fixed_resolution: true,
    fixed_swapchain_image_count: true,
    frame_capture_after_epoch_dispatch: true,
    presentation_fence_or_frame_boundary: true,
  };
}

function visualOracleArtifacts() {
  return {
    before_image: 'memory://visual-before.png',
    after_image: 'memory://visual-after.png',
    diff_image: 'memory://visual-diff.png',
    blank_frame_rejection: true,
    same_frame_rejection: true,
    new_epoch_watermark_or_trace: `epoch-7 ${HASH_B} dispatch-1`,
    camera_state_hash: HASH_C,
    swapchain_size: [640, 480],
    capture_backend: 'mcp_screenshot',
    frame_number: 7,
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
    },
  };
}

function timingMetrics(overrides = {}) {
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

function ledgerRecord(overrides = {}) {
  return {
    project_id: 'strict-generic-gpu-project',
    edit_id: 'gpu-artifact-edit',
    backend: 'hip',
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
      proof: 'stream_event_proven',
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
      compute_oracle_artifacts: computeOracleArtifacts(),
    },
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'compiler_cache_warm',
    timings: timingMetrics(),
    model_provenance: modelProvenance(),
    evidence_refs: ['runtime:module-load', 'runtime:epoch-publish', 'runtime:dispatch', 'runtime:output-oracle'],
    ...overrides,
  };
}

function visualLedgerRecord(overrides = {}) {
  return ledgerRecord({
    backend: 'hiprt',
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
    oracle_artifacts: {
      visual_oracle_artifacts: visualOracleArtifacts(),
    },
    deterministic_visual_mode: deterministicVisualMode(),
    ...overrides,
  });
}

function acceptanceContract(overrides = {}) {
  return {
    contract_version: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    contract_hash: HASH_C,
    project_id: 'strict-generic-gpu-project',
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
      evidence_source: 'strict-self-check:reload-boundary',
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
      evidence_refs: ['evidence:fission-verifier-report:strict-self-check', 'runtime:module-load'],
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
      field_evidence_refs: {
        kernel_name: ['runtime:hip-kernel-symbol'],
        launch_api: ['runtime:hip-launch-api'],
        grid_dim: ['runtime:hip-launch-shape'],
        block_dim: ['runtime:hip-launch-shape'],
        shared_mem_bytes: ['runtime:hip-launch-shape'],
        stream: ['runtime:hip-stream'],
        kernel_params: ['runtime:hip-kernel-params'],
        code_object_metadata: ['code-object:metadata'],
        output_buffers: ['runtime:hip-output-buffer'],
        readback_oracle: ['runtime:hip-readback-oracle'],
      },
    },
    ...overrides,
  };
}

function runtimeArtifact(overrides = {}) {
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord());
  const contract = acceptanceContract();
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  return {
    proofId: 'proof-pass',
    fullRuntimeProven: true,
    gpuHmrSuccess: true,
    stageResults: [{
      stageId: 'full-runtime',
      status: 'passed',
      evidenceRefs: ['runtime:stage:full-runtime'],
    }],
    limitations: [],
    proofLedger,
    proofLedgerQuery: proofLedger.query,
    proofLedgerSourceConsistency: {
      accepted: true,
      mode: 'derived_only',
      failures: [],
    },
    acceptanceContract: contract,
    acceptanceContractEvaluation: contractEvaluation,
    acceptanceContractConsistency: { accepted: true },
    ...overrides,
  };
}

const passingArtifact = runtimeArtifact();

assert.equal(adversarialPreflightStrictGate(passingPreflight).status, 'pass');
assert.equal(runtimeProofArtifactStrictGate(passingArtifact).status, 'pass');
assert.equal(strictProofGateFailures([
  adversarialPreflightStrictGate(passingPreflight),
  runtimeProofArtifactStrictGate(passingArtifact),
]).length, 0);

assert.match(
  adversarialPreflightStrictGate({ ...passingPreflight, skipped: true, ok: false }).detail,
  /adversarial_preflight_skipped/,
);
assert.match(
  adversarialPreflightStrictGate({ ...passingPreflight, stdoutHash: '' }).detail,
  /adversarial_preflight_stdout_hash_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate({ ...passingArtifact, proofLedgerQuery: { gpuHmrSuccess: false } }).detail,
  /proof_ledger_query_rejected/,
);
assert.match(
  runtimeProofArtifactStrictGate((() => {
    const artifact = { ...passingArtifact };
    delete artifact.stageResults;
    return artifact;
  })()).detail,
  /runtime_proof_artifact_stage_results_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    stageResults: [{ stageId: 'dispatch', status: 'failed' }],
  }).detail,
  /runtime_proof_artifact_stage_failed/,
);
assert.match(
  runtimeProofArtifactStrictGate((() => {
    const artifact = { ...passingArtifact };
    delete artifact.limitations;
    return artifact;
  })()).detail,
  /runtime_proof_artifact_limitations_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    limitations: [{ code: 'output_oracle_not_verified' }],
  }).detail,
  /runtime_proof_artifact_limitations_present/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    deterministicVisualModeEvaluation: {
      accepted: false,
      failedGates: [{ code: 'frozen_camera_unproven' }],
    },
  }).detail,
  /deterministic_visual_mode_rejected/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    proofLedger: buildGpuHmrProofLedger(ledgerRecord({ cpu_hmr_used: true })),
    proofLedgerQuery: { gpuHmrSuccess: true, failedInvariants: [] },
  }).detail,
  /proof_ledger_recomputed_query_rejected/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    proofLedgerQuery: { gpuHmrSuccess: true, failedInvariants: [{ code: 'forged' }] },
  }).detail,
  /proof_ledger_query_mismatch/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    acceptanceContract: acceptanceContract({
      classification: {
        project_kind: 'gpu_project',
        edit_kind: 'host_only',
        route: 'cpu_hmr_or_host_reload',
      },
    }),
    acceptanceContractEvaluation: { accepted: true, failedGates: [] },
  }).detail,
  /acceptance_contract_recomputed_rejected/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    acceptanceContractEvaluation: { accepted: true, failedGates: [{ code: 'forged' }] },
  }).detail,
  /acceptance_contract_evaluation_mismatch/,
);
assert.match(
  runtimeProofArtifactStrictGate((() => {
    const artifact = { ...passingArtifact };
    delete artifact.proofLedger;
    return artifact;
  })()).detail,
  /proof_ledger_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate({ ...passingArtifact, acceptanceContractConsistency: null }).detail,
  /acceptance_contract_consistency_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate((() => {
    const artifact = { ...passingArtifact };
    delete artifact.proofLedgerSourceConsistency;
    return artifact;
  })()).detail,
  /proof_ledger_source_consistency_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    proofLedgerSourceConsistency: {
      accepted: false,
      failures: [{ code: 'proof_ledger_source_dispatch_event_id_mismatch' }],
    },
  }).detail,
  /proof_ledger_source_consistency_rejected/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    proofLedgerSourceConsistency: {
      accepted: true,
      mode: 'self_check_static_fixture',
      failures: [],
    },
  }).detail,
  /proof_ledger_source_consistency_unverified_mode/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    proofLedger: buildGpuHmrProofLedger(visualLedgerRecord()),
    proofLedgerQuery: buildGpuHmrProofLedger(visualLedgerRecord()).query,
  }).detail,
  /deterministic_visual_mode_missing/,
);
assert.match(
  runtimeProofArtifactStrictGates([], { requireAtLeastOne: true })[0].detail,
  /runtime_proof_artifact_missing/,
);
assert.equal(runtimeProofArtifactStrictGates([], { requireAtLeastOne: false }).length, 0);

console.log('gpu-hmr proof strict gates self-check passed');
