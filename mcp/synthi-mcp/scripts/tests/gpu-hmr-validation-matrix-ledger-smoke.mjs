#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  collectGpuHmrValidationMatrixLedger,
  GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
  queryGpuHmrValidationMatrixLedger,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';
import {
  assessGeneratedGpuSplitGranularity,
  verifyGeneratedGpuSplitDeterministicFission,
  GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
} from '../lib/gpu-hmr-generated-split-granularity.mjs';
import {
  buildGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from '../lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
  GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
} from '../lib/gpu-hmr-acceptance-contract.mjs';
import {
  evaluateGpuHmrDeterministicVisualMode,
  GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
} from '../lib/gpu-hmr-visual-evidence.mjs';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePng(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, PNG_HEADER);
}

async function writeRgbaPng(filePath, width, height, pixelAt) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = pixelAt(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function hashValue(label) {
  return `sha256:${sha256Hex(label)}`;
}

function contentHashFor(value) {
  return `sha256:${sha256Hex(stableJson(value))}`;
}

function selectedIslandIdFor(selectedPath, selectedKernel) {
  return `kernel:${selectedKernel}:${sha256Hex(selectedPath).slice(0, 16)}`;
}

function typedFissionEvidence(category, evidenceType, subject, payload = {}) {
  const contentHash = contentHashFor({
    schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    category,
    evidenceType,
    subject,
    payload,
  });
  return {
    schemaVersion: GPU_HMR_GENERATED_SPLIT_DETERMINISTIC_FISSION_EVIDENCE_SCHEMA_VERSION,
    category,
    evidenceType,
    evidenceRefs: [
      `evidence:generated-split-fission:${category}:sha256:${sha256Hex(stableJson({
        category,
        evidenceType,
        contentHash,
        subject,
      }))}`,
    ],
    contentHash,
    subject,
    payload,
  };
}

function deterministicFissionEvidenceFor({ selectedPath, selectedKernel, selectedIslandId }) {
  const subject = {
    selectedPath,
    sourcePaths: [selectedPath],
    selectedIslandId,
    targetSymbols: [selectedKernel],
  };
  return [
    typedFissionEvidence('selected_island_binding', 'selected_island_binding', subject),
    typedFissionEvidence('source_mapping', 'source_mapping', subject),
    typedFissionEvidence('include_closure', 'include_closure', subject),
    typedFissionEvidence('symbol_ownership', 'symbol_ownership', subject),
    typedFissionEvidence('dependency_closure', 'dependency_closure', subject),
    typedFissionEvidence('abi_membrane', 'abi_membrane', subject),
    typedFissionEvidence('compile_recipe', 'compile_proof', subject),
    typedFissionEvidence('loader_capability', 'loader_runtime_proof', subject),
    typedFissionEvidence('output_oracle', 'output_oracle_proof', subject),
  ];
}

function hashBuffer(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function modelProvenance(requestMode, requestedModel) {
  return {
    provider: 'google_gemini',
    requested_model: requestedModel,
    provider_model_status: 'available',
    provider_model_alias_resolved_to: requestedModel,
    provider_shutdown_or_deprecation_detected: false,
    model_availability_checked_at: '2026-06-09T00:00:00.000Z',
    model_availability_source: 'provider_model_registry',
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 1,
    actual_model: requestedModel,
    fallback_model: 'not_used',
    fallback_used: false,
    request_mode: requestMode,
    hard_infra_failure: false,
  };
}

function timingFields(scope) {
  return {
    static_discovery_time: 1,
    ai_contract_synthesis_time: 1,
    model_availability_check_time: 1,
    artifact_hash_time: 1,
    adapter_generation_time: 1,
    device_compile_wall_time: scope === 'hot_delta_2' ? 22000000 : 45000000,
    artifact_load_time: 1,
    epoch_publish_time: 1,
    dispatch_trace_time: 1,
    runtime_probe_time: 3000000000,
    oracle_analysis_time: 1,
    trigger_to_visible_time: 3200000000,
    screenshot_capture_time: 1,
    dispatch_to_output_proof_time: 1,
    total_validator_wall_time: 3300000000,
  };
}

function deterministicMode(scope) {
  return {
    schemaVersion: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
    fixed_seed: true,
    seed_policy_fixed: true,
    seed_policy_hash: hashValue(`seed:${scope}`),
    frozen_camera: true,
    temporal_accumulation_not_applicable: true,
    taa_not_applicable: true,
    denoiser_not_applicable: true,
    fixed_resolution: true,
    fixed_swapchain_image_count: true,
    frame_capture_after_epoch_dispatch: true,
    presentation_fence_or_frame_boundary: true,
    warmup_frames: 2,
  };
}

function visualOracleArtifacts(scope, visualRoot = visualDir) {
  return {
    before_image: path.join(visualRoot, 'before-hmr-first.png'),
    before_image_hash: hashValue(`before-image:${scope}`),
    before_image_hash_verified: true,
    after_image: path.join(visualRoot, 'after-hmr-first.png'),
    after_image_hash: hashValue(`after-image:${scope}`),
    after_image_hash_verified: true,
    diff_image: path.join(visualRoot, 'before-after-diff.png'),
    diff_image_hash: hashValue(`diff-image:${scope}`),
    diff_image_hash_verified: true,
    blank_frame_rejection: true,
    same_frame_rejection: true,
    new_epoch_watermark_or_trace: `epoch=epoch:${scope} dispatch=dispatch:${scope} artifact=${hashValue(`artifact-after:${scope}`)}`,
    camera_state_hash: hashValue(`camera:${scope}`),
    swapchain_size: [800, 600],
    capture_backend: 'mcp_decoded_frame',
    frame_number: scope === 'hot_delta_2' ? 42 : 24,
    timestamp_after_dispatch: 4000,
    perceptual_diff: 6.5,
    changed_pixel_ratio: 0.042,
    visible_pixel_count: 2000,
    pixel_metrics_verified: true,
  };
}

function acceptanceContract(scope, options = {}) {
  const projectId = options.projectId ?? 'flow';
  const evidenceRef = `evidence:synthetic-runtime:${scope}`;
  const beforeHash = hashValue(`artifact-before:${scope}`);
  const afterHash = hashValue(`artifact-after:${scope}`);
  const fissionEvidenceRef = `evidence:fission-verifier-report:synthetic:${scope}`;
  const fieldEvidence = Object.fromEntries([
    'kernel_name',
    'launch_api',
    'grid_dim',
    'block_dim',
    'shared_mem_bytes',
    'stream',
    'kernel_params',
    'code_object_metadata',
    'output_buffers',
    'readback_oracle',
  ].map((field) => [field, [evidenceRef]]));
  return {
    contract_version: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    project_id: projectId,
    edit_id: `source-edit:${scope}`,
    backend: 'hip',
    confidence: 0.95,
    evidence_refs: [evidenceRef, fissionEvidenceRef],
    ai_hints: [],
    unsupported_reasons: [],
    failure_mode: 'reject',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
      confidence: 0.95,
      blocking_gaps: [],
    },
    artifact_identity: {
      source_paths: ['gpu/device.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['flow_kernel'],
      compile_target: 'gfx1201',
      compiler: 'hipcc',
      compiler_args_hash: hashValue(`compile-args:${scope}`),
    },
    artifact_hash_before: beforeHash,
    artifact_hash_after: afterHash,
    unaffected_artifacts_hash_unchanged: true,
    abi_compatibility_class: {
      value: 'compatible',
      evidence_refs: [evidenceRef],
    },
    abi_metadata: {
      args: [{
        name: 'out',
        type: 'float*',
        size: 8,
        offset: 0,
        value_kind: 'global_buffer',
        access: 'write',
        address_space: 'global',
        source: 'runtime_trace',
      }],
      workgroup_or_launch_shape: { grid_dim: [1, 1, 1], block_dim: [64, 1, 1] },
      stream_or_queue_requirements: { stream: 'stream:0' },
      extractor_sources: ['code_object_metadata'],
    },
    reload_mechanism: 'generated_adapter',
    adapter_outcome: 'adapter_generated',
    reload_evidence_refs: [evidenceRef],
    output_oracle_target: {
      kind: 'compute',
      target_id: 'buffer:flow-output',
      compute_only_target_verified: true,
      evidence_refs: [evidenceRef],
    },
    firewall_evidence: {
      route: 'gpu_hmr',
      evidence_source: 'runtime_trace',
      evidence_refs: [evidenceRef],
      cpu_hmr_used: false,
      full_rebuild_used: false,
      process_restarted: false,
      process_id_before: 'pid:4242',
      process_id_after: 'pid:4242',
    },
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: 'pid:4242',
      device_uuid: 'gpu:synthetic-rocm',
      context_or_device_handle: 'context:0',
      queue_or_stream_handle: 'stream:0',
      persistent_gpu_allocations: ['alloc:output'],
    },
    epoch_policy: {
      publish_mechanism: 'runtime_epoch_publish',
      dispatch_binding: 'dispatch_table_epoch_binding',
      retirement_mechanism: 'stream_event',
    },
    epoch_retirement_proof: {
      value: 'stream_event_proven',
      evidence_refs: [evidenceRef],
    },
    fission_report: {
      selected_island: 'island:flow-kernel',
      selected_reason: 'verified_fission_contract',
      changed_sources: ['gpu/device.hip'],
      included_dependencies: [{ path: 'gpu/device.hip' }],
      excluded_host_sources: ['src/main.cpp'],
      artifact_hash_before: beforeHash,
      artifact_hash_after: afterHash,
      abi_compatibility_class: 'compatible',
      full_device_fallback: false,
      host_relinked: false,
      process_restarted: false,
      full_rebuild_used: false,
      unaffected_artifacts_hash_unchanged: true,
      selected_verifier_evidence_id: fissionEvidenceRef,
      deterministic_verifier_evidence_refs: [evidenceRef, fissionEvidenceRef],
      selection_decision_hash: hashValue(`selection:${scope}`),
      output_oracle_contract: {
        kind: 'buffer_checksum',
        expected: 'runtime_readback_changed_after_epoch_dispatch',
        evidence_refs: [evidenceRef],
      },
      evidence_refs: [evidenceRef, fissionEvidenceRef],
    },
    hip_contract: {
      kernel_name: 'flow_kernel',
      launch_api: 'hipModuleLaunchKernel',
      grid_dim: [1, 1, 1],
      block_dim: [64, 1, 1],
      shared_mem_bytes: 0,
      stream: 'stream:0',
      kernel_params: ['out'],
      code_object_metadata: { source: 'code_object_metadata', kernel: 'flow_kernel' },
      output_buffers: ['buffer:flow-output'],
      readback_oracle: 'buffer_checksum_after_dispatch',
      field_evidence_refs: fieldEvidence,
    },
  };
}

function runtimeProofMaterials(scope, options = {}) {
  const projectId = options.projectId ?? 'flow';
  const visualRoot = options.visualRoot ?? visualDir;
  const sourceAdaptedVisualProfile = options.sourceAdaptedVisualProfile === true;
  const runtimeSessionId = options.runtimeSessionId ?? `runtime-session:${scope}`;
  const outputRuntimeSessionId = options.outputRuntimeSessionId ?? runtimeSessionId;
  const dispatchTableEntryId = options.dispatchTableEntryId ?? `dispatch-table-entry:${scope}`;
  const outputTargetId = options.outputTargetId ?? `output-target:${scope}`;
  const evidenceRef = `evidence:synthetic-runtime:${scope}`;
  const beforeHash = hashValue(`artifact-before:${scope}`);
  const afterHash = hashValue(`artifact-after:${scope}`);
  const timings = timingFields(scope);
  const deterministicVisualMode = deterministicMode(scope);
  const visualArtifacts = visualOracleArtifacts(scope, visualRoot);
  const proofLedger = buildGpuHmrProofLedger({
    project_id: projectId,
    edit_id: `source-edit:${scope}`,
    backend: 'hip',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: hashValue(`contract:${scope}`),
    artifact_before_hash: beforeHash,
    artifact_after_hash: afterHash,
    loader_event: {
      id: `loader:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      selected_loader_transport: 'ram_bytes',
      artifact_transport: {
        selected_loader_transport: 'ram_bytes',
        artifact_hash: afterHash,
        blob_digest: afterHash,
      },
      timestamp_monotonic_ns: 1000,
      process_id: 'pid:4242',
    },
    epoch_publish_event: {
      id: `epoch-publish:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      timestamp_monotonic_ns: 2000,
      process_id: 'pid:4242',
    },
    dispatch_event: {
      id: `dispatch:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      output_target_id: outputTargetId,
      timestamp_monotonic_ns: 3000,
      process_id: 'pid:4242',
    },
    output_event: {
      id: `output:${scope}`,
      kind: 'visual_frame',
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: outputRuntimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      output_target_id: outputTargetId,
      after_dispatch_id: `dispatch:${scope}`,
      timestamp_monotonic_ns: 4000,
      process_id: 'pid:4242',
      passed: true,
      visual_oracle_artifacts: visualArtifacts,
    },
    retirement_event: {
      id: `retire:${scope}`,
      epoch: `epoch:${scope}`,
      timestamp_monotonic_ns: 5000,
      process_id: 'pid:4242',
      proof: 'stream_event_proven',
    },
    process_identity: { process_id: 'pid:4242', runtime_session_id: runtimeSessionId },
    device_identity: { device_uuid: 'gpu:synthetic-rocm', backend: 'hip' },
    oracle_artifacts: { visual_oracle_artifacts: visualArtifacts },
    deterministic_visual_mode: deterministicVisualMode,
    metric_clock: 'monotonic_ns',
    metric_scope: scope,
    cache_state: 'compiler_cache_warm',
    timings,
    modelProvenance: {
      split: modelProvenance('split', 'gemini-3.5-flash'),
      gpu_delta: modelProvenance('gpu_delta', 'gemini-3.1-flash-lite'),
    },
    evidence_refs: [evidenceRef],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    cpu_hmr_used_evidence_present: true,
    full_rebuild_used_evidence_present: true,
    process_restarted_evidence_present: true,
    firewall_process_id_before: 'pid:4242',
    firewall_process_id_after: 'pid:4242',
  });
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  assert.deepEqual(proofLedgerQuery.failedInvariants, []);
  assert.equal(proofLedgerQuery.gpuHmrSuccess, true);
  const contract = acceptanceContract(scope, { projectId });
  const acceptanceContractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  assert.deepEqual(acceptanceContractEvaluation.failedGates, []);
  assert.equal(acceptanceContractEvaluation.accepted, true);
  const acceptanceContractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: contract,
    derivedContract: contract,
  });
  assert.equal(acceptanceContractConsistency.accepted, true);
  const deterministicVisualModeEvaluation =
    evaluateGpuHmrDeterministicVisualMode(deterministicVisualMode);
  assert.equal(deterministicVisualModeEvaluation.accepted, true);
  const runtimeProofArtifact = {
    proofId: `runtime-proof-artifact:sha256:${sha256Hex(scope)}`,
    fullRuntimeProven: sourceAdaptedVisualProfile ? false : true,
    gpuHmrSuccess: sourceAdaptedVisualProfile ? false : true,
    visualProfileAccepted: sourceAdaptedVisualProfile,
    sourceAdaptedProfile: sourceAdaptedVisualProfile,
    stageResults: [
      { stageId: 'fission-candidate-verification', status: 'passed' },
      { stageId: 'device-compile', status: 'passed' },
      { stageId: 'artifact-load', status: 'passed' },
      { stageId: 'epoch-publish', status: 'passed' },
      { stageId: 'dispatch-trace', status: 'passed' },
      { stageId: 'output-oracle', status: 'passed' },
      {
        stageId: 'no-source-adapted-profile',
        status: sourceAdaptedVisualProfile ? 'failed' : 'passed',
      },
    ],
    limitations: sourceAdaptedVisualProfile
      ? [{ code: 'source_adapted_profile_not_no_shim_gpu_hmr' }]
      : [],
    proofLedger,
    proofLedgerQuery,
    acceptanceContract: contract,
    acceptanceContractEvaluation,
    acceptanceContractConsistency,
    proofLedgerSourceConsistency: {
      accepted: true,
      mode: 'derived_only',
    },
    deterministicVisualMode,
    deterministicVisualModeEvaluation,
  };
  return {
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery,
    proof_ledger_query: proofLedgerQuery,
    runtimeProofArtifact,
    runtime_proof_artifact: runtimeProofArtifact,
  };
}

function computeProofLedgerMaterials(scope, {
  projectId,
  rawReadbackPath,
  rawReadbackBytes = null,
  runtimeSessionId = `runtime-session:${scope}`,
  outputRuntimeSessionId = runtimeSessionId,
  dispatchTableEntryId = `dispatch-table-entry:${scope}`,
  outputTargetId = `output-target:${scope}`,
}) {
  const beforeHash = hashValue(`compute-artifact-before:${scope}`);
  const afterHash = hashValue(`compute-artifact-after:${scope}`);
  const actualRawReadbackBytes = Buffer.isBuffer(rawReadbackBytes) ? rawReadbackBytes : null;
  const deterministicSliceLength = Math.min(4, actualRawReadbackBytes?.length ?? 4);
  const rawReadbackHash = actualRawReadbackBytes
    ? hashBuffer(actualRawReadbackBytes)
    : hashValue(`raw-readback:${scope}`);
  const deterministicSliceHash = actualRawReadbackBytes
    ? hashBuffer(actualRawReadbackBytes.subarray(0, deterministicSliceLength))
    : hashValue(`raw-readback-slice:${scope}`);
  const computeOracleArtifacts = {
    raw_readback_bin: rawReadbackPath,
    readback_schema_json: `${rawReadbackPath}.schema.json`,
    checksum_before: hashValue(`compute-checksum-before:${scope}`),
    checksum_after: hashValue(`compute-checksum-after:${scope}`),
    deterministic_slice: {
      offset: 0,
      length: deterministicSliceLength,
      hash: deterministicSliceHash,
    },
    deterministic_slice_hash: deterministicSliceHash,
    deterministic_slice_hash_verified: true,
    oracle_code_hash: hashValue(`compute-oracle-code:${scope}`),
    rendered_card_png: `${rawReadbackPath}.card.png`,
    producer: 'synthetic_compute_oracle',
    timestamp_after_dispatch: 4000,
    epoch: `epoch:${scope}`,
    raw_readback_hash: rawReadbackHash,
    raw_readback_hash_verified: true,
    raw_readback_byte_length: actualRawReadbackBytes?.length ?? 4,
    raw_readback_source: 'runtime_raw_readback',
    output_change_expected: true,
  };
  const proofLedger = buildGpuHmrProofLedger({
    project_id: projectId,
    edit_id: `source-edit:${scope}`,
    backend: 'hip',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: hashValue(`compute-contract:${scope}`),
    artifact_before_hash: beforeHash,
    artifact_after_hash: afterHash,
    loader_event: {
      id: `loader:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      selected_loader_transport: 'ram_bytes',
      artifact_transport: {
        selected_loader_transport: 'ram_bytes',
        artifact_hash: afterHash,
        blob_digest: afterHash,
      },
      timestamp_monotonic_ns: 1000,
      process_id: 'pid:4242',
    },
    epoch_publish_event: {
      id: `epoch-publish:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      timestamp_monotonic_ns: 2000,
      process_id: 'pid:4242',
    },
    dispatch_event: {
      id: `dispatch:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      output_target_id: outputTargetId,
      timestamp_monotonic_ns: 3000,
      process_id: 'pid:4242',
    },
    output_event: {
      id: `output:${scope}`,
      kind: 'compute_oracle',
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: afterHash,
      runtime_session_id: outputRuntimeSessionId,
      dispatch_table_entry_id: dispatchTableEntryId,
      output_target_id: outputTargetId,
      after_dispatch_id: `dispatch:${scope}`,
      timestamp_monotonic_ns: 4000,
      process_id: 'pid:4242',
      passed: true,
      compute_oracle_artifacts: computeOracleArtifacts,
    },
    retirement_event: {
      id: `retire:${scope}`,
      epoch: `epoch:${scope}`,
      timestamp_monotonic_ns: 5000,
      process_id: 'pid:4242',
      proof: 'stream_event_proven',
    },
    process_identity: { process_id: 'pid:4242', runtime_session_id: runtimeSessionId },
    device_identity: { device_uuid: 'gpu:synthetic-rocm', backend: 'hip' },
    oracle_artifacts: { compute_oracle_artifacts: computeOracleArtifacts },
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'compiler_cache_warm',
    timings: timingFields('hot_delta_1'),
    modelProvenance: {
      split: modelProvenance('split', 'gemini-3.5-flash'),
      gpu_delta: modelProvenance('gpu_delta', 'gemini-3.1-flash-lite'),
    },
    evidence_refs: [`evidence:synthetic-compute:${scope}`],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    cpu_hmr_used_evidence_present: true,
    full_rebuild_used_evidence_present: true,
    process_restarted_evidence_present: true,
    firewall_process_id_before: 'pid:4242',
    firewall_process_id_after: 'pid:4242',
  });
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  assert.deepEqual(proofLedgerQuery.failedInvariants, []);
  assert.equal(proofLedgerQuery.gpuHmrSuccess, true);
  const contract = acceptanceContract(scope, { projectId });
  const acceptanceContractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  assert.deepEqual(acceptanceContractEvaluation.failedGates, []);
  assert.equal(acceptanceContractEvaluation.accepted, true);
  const acceptanceContractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: contract,
    derivedContract: contract,
  });
  assert.equal(acceptanceContractConsistency.accepted, true);
  const runtimeProofArtifact = {
    proofId: `runtime-proof-artifact:sha256:${sha256Hex(`compute:${scope}`)}`,
    fullRuntimeProven: true,
    gpuHmrSuccess: true,
    stageResults: [
      { stageId: 'fission-candidate-verification', status: 'passed' },
      { stageId: 'device-compile', status: 'passed' },
      { stageId: 'artifact-load', status: 'passed' },
      { stageId: 'epoch-publish', status: 'passed' },
      { stageId: 'dispatch-trace', status: 'passed' },
      { stageId: 'output-oracle', status: 'passed' },
    ],
    limitations: [],
    proofLedger,
    proofLedgerQuery,
    acceptanceContract: contract,
    acceptanceContractEvaluation,
    acceptanceContractConsistency,
    proofLedgerSourceConsistency: {
      accepted: true,
      mode: 'derived_only',
    },
  };
  return {
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery,
    proof_ledger_query: proofLedgerQuery,
    runtimeProofArtifact,
    runtime_proof_artifact: runtimeProofArtifact,
    computeOracleArtifacts,
  };
}

function hiprtWarmProofArtifact({
  slug,
  profileId,
  baselinePath,
  changedPath,
  diffPath,
  oracleRegionClaimNonBlank = true,
}) {
  const materials = runtimeProofMaterials('hot_delta_1', {
    projectId: profileId,
    visualRoot: path.dirname(diffPath),
    sourceAdaptedVisualProfile: true,
  });
  const runtimeProbeInstrumentation = hiprtRuntimeProbeInstrumentation(profileId);
  return {
    schemaVersion: 'synthi.hiprt.warm_visual_proof.v2',
    slug,
    createdAt: '2026-06-09T00:00:00.000Z',
    mode: 'same-process',
    metricScope: 'hot_delta_1',
    metric_scope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    cache_state: 'compiler_cache_warm',
    profile: { id: profileId },
    accepted: true,
    acceptance: {
      strictProvenance: true,
      sameProcessRuntime: true,
      visualDelta: true,
      oracleRegionNonBlank: oracleRegionClaimNonBlank,
    },
    runtime: {
      baseline: { localCapturePath: baselinePath },
      changed: {
        localCapturePath: changedPath,
        sameProcess: true,
        liveRecompileMs: 1,
        totalHostWallMs: 2,
      },
    },
    diff: {
      path: diffPath,
      changedPixelRatioThreshold4: 1,
      meanAbsDelta8bit: 10,
      oracleRegion: {
        thresholds: {
          minVisibleRatio: 0.02,
          minMeanLuma8bit: 4,
          minUniqueColorSampleCount: 1,
        },
        changedPixelsThreshold4: 64,
        changedPixelRatioThreshold4: 1,
        changed: {
          pixels: 64,
          visiblePixels: oracleRegionClaimNonBlank ? 64 : 0,
          visiblePixelRatio: oracleRegionClaimNonBlank ? 1 : 0,
          meanLuma8bit: oracleRegionClaimNonBlank ? 16 : 0,
          uniqueColorSampleCount: oracleRegionClaimNonBlank ? 4 : 1,
        },
        nonBlankAfterEpoch: oracleRegionClaimNonBlank,
        blankFrameRejected: oracleRegionClaimNonBlank,
      },
    },
    strictHmrProvenance: {
      fullRuntimeProven: true,
      strictFullRuntimePassed: true,
    },
    runtimeProbeInstrumentation,
    runtime_probe_instrumentation: runtimeProbeInstrumentation,
    timings: {
      totalWallMs: 3,
    },
    timingMetrics: {
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: `source-edit:${slug}:hot1`,
      editHash: `sha256:${sha256Hex(`${slug}:hot1`)}`,
      editKind: 'gpu_artifact_edit',
    },
    ...materials,
  };
}

function hiprtRuntimeProbeInstrumentation(profileId) {
  return {
    schemaVersion: 'synthi.gpu.hmr.profile_probe_instrumentation.v1',
    kind: 'declared_profile_probe_instrumentation',
    instrumentationKind: 'profile_probe_instrumentation',
    instrumentation_kind: 'profile_probe_instrumentation',
    adapterFamily: 'hiprt-path-tracer-profile-adapter',
    adapter_family: 'hiprt-path-tracer-profile-adapter',
    profileId,
    profile_id: profileId,
    accepted: true,
    applied: true,
    adaptedOrAlreadyPresent: true,
    adapted_or_already_present: true,
    sourceAdaptations: [
      'runtime_capture_from_device_framebuffer',
      'same_process_targeted_kernel_recompile_hook',
    ],
    source_adaptations: [
      'runtime_capture_from_device_framebuffer',
      'same_process_targeted_kernel_recompile_hook',
    ],
    files: [
      { path: 'src/Renderer/GPURendererThread.cpp', status: 'adapted' },
    ],
    acceptanceScope: 'hiprt_declared_visual_profile',
    acceptance_scope: 'hiprt_declared_visual_profile',
    proofAuthority: 'runtime_probe_instrumentation_disclosure_not_universal_hmr',
    proof_authority: 'runtime_probe_instrumentation_disclosure_not_universal_hmr',
    executionBoundary: 'HIPRT-Path-Tracer profile adapter with explicit source hooks',
    execution_boundary: 'HIPRT-Path-Tracer profile adapter with explicit source hooks',
    arbitraryTargetRuntimeAccepted: false,
    arbitrary_target_runtime_accepted: false,
    arbitraryLibraryAccepted: false,
    arbitrary_library_accepted: false,
    broadApplicationAcceptance: false,
    broad_application_acceptance: false,
    broadHipApplicationAcceptance: false,
    broad_hip_application_acceptance: false,
    unsupportedWithoutEvidence: [
      'unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook',
    ],
    unsupported_without_evidence: [
      'unknown_hiprt_app_without_declared_scene_bvh_framebuffer_reload_hook',
    ],
  };
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-validation-matrix-'));
const mcpRoot = path.join(tmpRoot, 'mcp', 'synthi-mcp');
const logsRoot = path.join(mcpRoot, '.gpu-hmr-test-logs');
const artifactsRoot = path.join(mcpRoot, '.gpu-hmr-test-artifacts');

const visualDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow');
await writeRgbaPng(path.join(visualDir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(visualDir, 'after-hmr-first.png'), 8, 8, (x, y) => [16 + x, 24 + y, 48, 255]);
await writeRgbaPng(path.join(visualDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(visualDir, 'agent-split-results.json'), [
  { name: 'fixture', status: 'pass', detail: 'flow' },
  { name: 'worker used GPU split endpoint', status: 'pass', detail: 'GPU markers detected' },
  { name: 'generated split contains HMR ABI', status: 'pass', detail: 'shared.h, core.cpp, device.hip' },
  { name: 'generated split HMR granularity', status: 'pass', detail: 'claim=device_translation_unit_hmr rejected_claims=per_kernel_hmr' },
  {
    name: 'mcp wait_hmr proof gate',
    status: 'pass',
    detail: JSON.stringify({
      gpu_proof_validation: {
        satisfied: true,
        proofLedgerValidation: {
          proofId: 'gpu-ledger-proof:sha256:synthetic',
          gpuHmrSuccess: true,
          failedInvariants: [],
        },
        runtimeProofArtifactValidation: {
          accepted: true,
          failedGates: [],
        },
      },
      gpu_proof_telemetry: {
        proofId: 'gpu-runtime-proof:sha256:synthetic',
      },
      timingMetrics: {
        metricClock: 'monotonic_ns',
        metricScope: 'hot_delta_1',
        cacheState: 'compiler_cache_warm',
      },
    }),
  },
  { name: 'device-only GPU HMR observed', status: 'pass', detail: '[gpu-reload] plan=device_only' },
  {
    name: 'mcp screenshot before hmr',
    status: 'pass',
    detail: `images=${path.join(visualDir, 'before-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot after hmr',
    status: 'pass',
    detail: `images=${path.join(visualDir, 'after-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot visual delta',
    status: 'pass',
    detail: `changed=4.20% mean_abs=6.50 selected_delta_ms=123 diff=${path.join(visualDir, 'before-after-diff.png')}`,
  },
  { name: 'runner stayed alive after GPU HMR', status: 'pass', detail: 'no runner crash marker' },
]);

const forgedLegacyDir = path.join(logsRoot, 'agent-split-artifacts', 'forged-legacy-preview');
await writeRgbaPng(path.join(forgedLegacyDir, 'before-hmr-first.png'), 8, 8, () => [8, 8, 8, 255]);
await writeRgbaPng(path.join(forgedLegacyDir, 'after-hmr-first.png'), 8, 8, (x, y) => [64 + x, 80 + y, 128, 255]);
await writeRgbaPng(path.join(forgedLegacyDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedLegacyDir, 'agent-split-results.json'), [
  { name: 'fixture', status: 'pass', detail: 'forged legacy preview with embedded claims only' },
  { name: 'worker used GPU split endpoint', status: 'pass', detail: 'GPU markers detected' },
  { name: 'generated split contains HMR ABI', status: 'pass', detail: 'shared.h, core.cpp, device.hip' },
  { name: 'generated split HMR granularity', status: 'pass', detail: 'claim=device_translation_unit_hmr' },
  {
    name: 'mcp wait_hmr proof gate',
    status: 'pass',
    detail: JSON.stringify({
      backend: 'hip',
      targetId: 'forged-legacy-preview',
      profileId: 'forged-legacy-preview',
      gpu_proof_validation: {
        satisfied: true,
        proofLedgerValidation: {
          proofId: 'gpu-ledger-proof:sha256:forged-legacy-preview',
          gpuHmrSuccess: true,
          failedInvariants: [],
        },
        runtimeProofArtifactValidation: {
          accepted: true,
          failedGates: [],
        },
      },
      gpu_proof_telemetry: {
        proofId: 'gpu-runtime-proof:sha256:forged-legacy-preview',
      },
      timingMetrics: {
        metricClock: 'monotonic_ns',
        metricScope: 'hot_delta_1',
        cacheState: 'compiler_cache_warm',
      },
    }),
  },
  { name: 'device-only GPU HMR observed', status: 'pass', detail: '[gpu-reload] plan=device_only' },
  {
    name: 'mcp screenshot before hmr',
    status: 'pass',
    detail: `images=${path.join(forgedLegacyDir, 'before-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot after hmr',
    status: 'pass',
    detail: `images=${path.join(forgedLegacyDir, 'after-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot visual delta',
    status: 'pass',
    detail: `changed=4.20% mean_abs=6.50 selected_delta_ms=123 diff=${path.join(forgedLegacyDir, 'before-after-diff.png')}`,
  },
  { name: 'runner stayed alive after GPU HMR', status: 'pass', detail: 'no runner crash marker' },
]);

const runModeProofBase = {
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  backend: 'hip',
  targetId: 'flow',
  profileId: 'flow',
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  visualArtifacts: {
    beforeImage: path.join(visualDir, 'before-hmr-first.png'),
    afterImage: path.join(visualDir, 'after-hmr-first.png'),
    diffImage: path.join(visualDir, 'before-after-diff.png'),
  },
  visualMetrics: {
    changedPixelRatio: 0.042,
    meanAbsDelta8bit: 6.5,
    visiblePixelCount: 2000,
  },
};

function waitProofValidation(proofId, runtimeProofId) {
  return {
    gpuProofValidation: {
      satisfied: true,
      proofLedgerValidation: {
        proofId,
        gpuHmrSuccess: true,
        failedInvariants: [],
      },
      runtimeProofArtifactValidation: {
        accepted: true,
        failedGates: [],
      },
    },
    gpuProofTelemetry: {
      proofId: runtimeProofId,
    },
  };
}

function runModeCoverageSupportFor(materials, extraProofIds = []) {
  const record = materials.proofLedgerQuery?.record ?? materials.proofLedger?.records?.[0] ?? {};
  return {
    schemaVersion: 'synthi.gpu.hmr.run_mode_coverage_support.v1',
    parentProofIds: [...new Set([
      materials.proofLedger?.proofId,
      materials.proofLedger?.proof_id,
      record.proofId,
      record.proof_id,
      materials.runtimeProofArtifact?.proofId,
      materials.runtimeProofArtifact?.proof_id,
      ...extraProofIds,
    ].filter(Boolean))],
    contractHash: record.contractHash ?? record.contract_hash,
    artifactBeforeHash: record.artifactBeforeHash ?? record.artifact_before_hash,
    artifactAfterHash: record.artifactAfterHash ?? record.artifact_after_hash,
  };
}

function validationProfileEvidenceFor({ profileId, profileClass, evidenceRefs, proofIds }) {
  return {
    schemaVersion: 'synthi.gpu.hmr.validation_profile_evidence.v1',
    accepted: true,
    profileId,
    profileClass,
    source: 'explicit_validation_matrix_profile_contract',
    evidenceRefs,
    proofIds,
  };
}

const flowHot1RuntimeMaterials = runtimeProofMaterials('hot_delta_1');
const flowHot2RuntimeMaterials = runtimeProofMaterials('hot_delta_2');
const flowRunModeCoverageSupport = runModeCoverageSupportFor(flowHot1RuntimeMaterials, [
  'gpu-runtime-proof:sha256:synthetic-hot1',
  'agent-split-run-mode-proof:sha256:hot1',
]);
const flowHot1VisualProfileEvidence = validationProfileEvidenceFor({
  profileId: 'flow',
  profileClass: 'flow_visual_gpu_path',
  evidenceRefs: [
    'evidence:validation-profile:flow:runtime-visual',
    flowHot1RuntimeMaterials.proofLedgerQuery.record.proofId,
  ],
  proofIds: [
    'agent-split-run-mode-proof:sha256:hot1',
    flowHot1RuntimeMaterials.proofLedgerQuery.record.proofId,
    flowHot1RuntimeMaterials.runtimeProofArtifact.proofId,
  ],
});
const flowHot2VisualProfileEvidence = validationProfileEvidenceFor({
  profileId: 'flow',
  profileClass: 'flow_visual_gpu_path',
  evidenceRefs: [
    'evidence:validation-profile:flow:runtime-visual',
    flowHot2RuntimeMaterials.proofLedgerQuery.record.proofId,
  ],
  proofIds: [
    'agent-split-run-mode-proof:sha256:hot2',
    flowHot2RuntimeMaterials.proofLedgerQuery.record.proofId,
    flowHot2RuntimeMaterials.runtimeProofArtifact.proofId,
  ],
});

await writeJson(path.join(visualDir, 'run-mode-cold.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  proofId: 'agent-split-run-mode-proof:sha256:cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  runModeCoverageSupport: flowRunModeCoverageSupport,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split',
    editHash: 'sha256:cold-split',
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:synthetic-hot1', 'gpu-runtime-proof:sha256:synthetic-hot1'),
  ...flowHot1RuntimeMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:hot1',
  validationProfileEvidence: flowHot1VisualProfileEvidence,
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1',
    editHash: 'sha256:hot1',
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot2.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation('gpu-ledger-proof:sha256:synthetic-hot2', 'gpu-runtime-proof:sha256:synthetic-hot2'),
  ...flowHot2RuntimeMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:hot2',
  validationProfileEvidence: flowHot2VisualProfileEvidence,
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot2',
    editHash: 'sha256:hot2',
    editKind: 'different_gpu_edit',
    differentEdit: true,
  },
});

const strictMissingArtifactMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'strict-runtime-missing-artifact',
});
await writeJson(path.join(artifactsRoot, 'strict-runtime-ledger', 'missing-runtime-proof-artifact.json'), {
  schemaVersion: 'synthi.gpu.hmr.proof.v1',
  proofId: 'gpu-runtime-proof:sha256:strict-missing-runtime-artifact',
  target_name: 'strict-runtime-missing-artifact',
  gpuHmrSuccess: true,
  fullRuntimeProven: true,
  resultState: 'gpu-hmr-full-runtime-proven',
  acceptanceContract: acceptanceContract('strict_missing_runtime_artifact', {
    projectId: 'strict-runtime-missing-artifact',
  }),
  proofLedger: strictMissingArtifactMaterials.proofLedger,
  proof_ledger: strictMissingArtifactMaterials.proof_ledger,
  proofLedgerQuery: strictMissingArtifactMaterials.proofLedgerQuery,
  proof_ledger_query: strictMissingArtifactMaterials.proof_ledger_query,
});

const strictComputeMissingReadbackPath = path.join(
  artifactsRoot,
  'strict-runtime-ledger',
  'missing-compute-readback.bin',
);
const strictComputeMissingReadbackMaterials = computeProofLedgerMaterials('strict-compute-missing-readback', {
  projectId: 'strict-runtime-compute-missing-readback',
  rawReadbackPath: strictComputeMissingReadbackPath,
});
await writeJson(path.join(artifactsRoot, 'strict-runtime-ledger', 'missing-compute-readback.json'), {
  schemaVersion: 'synthi.gpu.hmr.proof.v1',
  proofId: 'gpu-runtime-proof:sha256:strict-compute-missing-readback',
  target_name: 'strict-runtime-compute-missing-readback',
  gpuHmrSuccess: true,
  fullRuntimeProven: true,
  resultState: 'gpu-hmr-full-runtime-proven',
  acceptanceContract: acceptanceContract('strict_compute_missing_readback', {
    projectId: 'strict-runtime-compute-missing-readback',
  }),
  proofLedger: strictComputeMissingReadbackMaterials.proofLedger,
  proof_ledger: strictComputeMissingReadbackMaterials.proof_ledger,
  proofLedgerQuery: strictComputeMissingReadbackMaterials.proofLedgerQuery,
  proof_ledger_query: strictComputeMissingReadbackMaterials.proof_ledger_query,
  runtimeProofArtifact: strictComputeMissingReadbackMaterials.runtimeProofArtifact,
  runtime_proof_artifact: strictComputeMissingReadbackMaterials.runtime_proof_artifact,
});

await writeJson(path.join(visualDir, 'run-mode-forged-source-adapted-webgpu.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:forged-source-adapted-webgpu',
    'gpu-runtime-proof:sha256:forged-source-adapted-webgpu',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-source-adapted-webgpu',
  }),
  backend: 'webgpu',
  targetId: 'forged-source-adapted-webgpu',
  profileId: 'forged-source-adapted-webgpu',
  proofId: 'agent-split-run-mode-proof:sha256:forged-source-adapted-webgpu',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runtimeProbeInstrumentation: {
    sourceAdaptations: [
      'runtime_capture_hook_inserted',
      'application_render_state_reset_hook_inserted',
    ],
    adaptedOrAlreadyPresent: true,
  },
  runtime_probe_instrumentation: {
    source_adaptations: [
      'runtime_capture_hook_inserted',
      'application_render_state_reset_hook_inserted',
    ],
    adapted_or_already_present: true,
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:forged-source-adapted-webgpu',
    editHash: 'sha256:forged-source-adapted-webgpu',
    editKind: 'gpu_artifact_edit',
  },
});

await writeJson(path.join(visualDir, 'run-mode-forged-top-level-source-adapted-webgpu.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:forged-top-level-source-adapted-webgpu',
    'gpu-runtime-proof:sha256:forged-top-level-source-adapted-webgpu',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-top-level-source-adapted-webgpu',
  }),
  backend: 'webgpu',
  targetId: 'forged-top-level-source-adapted-webgpu',
  profileId: 'forged-top-level-source-adapted-webgpu',
  proofId: 'agent-split-run-mode-proof:sha256:forged-top-level-source-adapted-webgpu',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  sourceAdaptation: {
    sourceAdaptations: [
      'top_level_runtime_capture_hook_inserted',
      'top_level_dispatch_binding_rewrite',
    ],
    adaptedOrAlreadyPresent: true,
  },
  source_adaptation: {
    source_adaptations: [
      'top_level_runtime_capture_hook_inserted',
      'top_level_dispatch_binding_rewrite',
    ],
    adapted_or_already_present: true,
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:forged-top-level-source-adapted-webgpu',
    editHash: 'sha256:forged-top-level-source-adapted-webgpu',
    editKind: 'gpu_artifact_edit',
  },
});

await writeJson(path.join(visualDir, 'negative-edit-refusal.json'), {
  schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
  proofId: 'agent-split-negative-edit-refusal:sha256:synthetic',
  backend: 'hip',
  targetId: 'flow',
  profileId: 'flow',
  runModeCoverageSupport: flowRunModeCoverageSupport,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'negative-edit:abi-layout',
    editHash: 'sha256:negative-edit',
    editKind: 'negative_edit',
    differentEdit: true,
  },
  reasons: ['abi_compatibility_class_layout_changed', 'gpu_hmr_rejected_before_load'],
});

await writeJson(path.join(visualDir, 'forged-unlinked-flow-cold.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  proofId: 'agent-split-run-mode-proof:sha256:forged-unlinked-flow-cold',
  profileId: 'forged-unlinked-flow-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split-forged-unlinked',
    editHash: 'sha256:forged-unlinked-flow-cold',
  },
});

await writeJson(path.join(visualDir, 'stale-cold-only.json'), {
  ...runModeProofBase,
  targetId: 'stale-cold-only',
  profileId: 'stale-cold-only',
  proofId: 'agent-split-run-mode-proof:sha256:stale-cold-only',
  coldSplitProven: true,
  cold_split_proven: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split',
    editHash: 'sha256:stale-cold-only',
  },
});

const fissionManifest = {
  gpu: {
    vendor: 'rocm',
    device_roles: [
      { id: 'device.integrator', path: 'gpu/integrator.hip', compiler: 'hipcc', arch: ['gfx1201'] },
      { id: 'device.shading', path: 'gpu/shading.hip', compiler: 'hipcc', arch: ['gfx1201'] },
    ],
  },
};
const fissionFiles = {
  'gpu/integrator.hip': '__global__ void integrate(float* out) {}',
  'gpu/shading.hip': '__global__ void shade(float* out) {}',
};
const fissionAssessment = assessGeneratedGpuSplitGranularity({
  manifest: fissionManifest,
  files: fissionFiles,
});
const fissionSelectedPath = 'gpu/shading.hip';
const fissionSelectedKernel = 'shade';
const fissionSelectedIslandId = selectedIslandIdFor(fissionSelectedPath, fissionSelectedKernel);
const fissionTypedEvidence = deterministicFissionEvidenceFor({
  selectedPath: fissionSelectedPath,
  selectedKernel: fissionSelectedKernel,
  selectedIslandId: fissionSelectedIslandId,
});
const fissionReport = verifyGeneratedGpuSplitDeterministicFission({
  assessment: fissionAssessment,
  selectedPath: fissionSelectedPath,
  changedPaths: [fissionSelectedPath],
  selectedArtifact: {
    sourcePath: fissionSelectedPath,
    artifactId: `artifact:sha256:${sha256Hex('matrix-fission-artifact-id')}`,
    contentHash: hashValue('matrix-fission-artifact-content'),
    proofIds: [
      `gpu-runtime-proof:sha256:${sha256Hex('matrix-fission-runtime-proof')}`,
      `gpu-ledger-proof:sha256:${sha256Hex('matrix-fission-ledger-proof')}`,
    ],
  },
  verificationEvidence: fissionTypedEvidence,
  outputOracleContract: {
    oracleId: `oracle:generated-split-visual:sha256:${sha256Hex('matrix-fission-oracle')}`,
    kind: 'visual',
    target: 'framebuffer',
  },
  unaffectedArtifactHashesBefore: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  unaffectedArtifactHashesAfter: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  compilerArgsHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
await writeJson(path.join(visualDir, 'generated-split-deterministic-fission.json'), fissionReport);

const openClPreflightEvidenceRef = 'evidence:synthetic-opencl-preflight:runtime-capability';
await writeJson(path.join(artifactsRoot, 'opencl-preflight', 'opencl-proof.json'), {
  schema: 'synthi.gpu_hmr.opencl_preflight.v1',
  slug: 'synthetic-opencl-preflight',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'opencl',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    backendFamily: {
      value: 'opencl',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    runtimeCapabilityPreflight: {
      backend: 'opencl',
      backendFamily: 'opencl',
      probe: 'opencl_vendor_icd_preflight',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    evidenceRefs: [openClPreflightEvidenceRef],
  },
  classification: {
    backend: {
      value: 'opencl',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    backendFamily: 'opencl',
    runtimeCapabilityPreflight: {
      backend: 'opencl',
      backendFamily: 'opencl',
      probe: 'opencl_vendor_icd_preflight',
      evidenceRefs: [openClPreflightEvidenceRef],
    },
    openclAccepted: false,
    resultState: 'opencl-runtime-rejected',
    unsupportedReasons: ['opencl_vendor_icd_missing'],
  },
  acceptance: {
    acceptedForOpenClRuntimePreflight: false,
    acceptedForOpenClOutputProof: false,
    gpuHmrSuccess: true,
    noShimApplied: true,
    noVendorIcdSynthesized: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'opencl-preflight-proof:sha256:synthetic',
});

const legacySchemaOnlyPreflightDir = path.join(artifactsRoot, 'legacy-schema-only-preflight');
await writeJson(path.join(legacySchemaOnlyPreflightDir, 'schema-only-opencl-preflight.json'), {
  schema: 'synthi.gpu_hmr.opencl_preflight.v1',
  slug: 'legacy-schema-only-opencl-preflight',
  classification: {
    openclAccepted: true,
    resultState: 'opencl-runtime-observed',
    unsupportedReasons: [],
  },
  acceptance: {
    acceptedForOpenClRuntimePreflight: true,
    acceptedForOpenClOutputProof: false,
    gpuHmrSuccess: false,
    noShimApplied: true,
    noVendorIcdSynthesized: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'opencl-preflight-proof:sha256:legacy-schema-only',
});

await writeJson(path.join(logsRoot, 'external-projects', 'bevy-wgsl-name-only-rejection-proof.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_rejection.v1',
  profileId: 'bevy-wgsl-name-only',
  proofMode: 'mcp_preview',
  status: 'fail',
  rejection: {
    accepted: false,
    reasons: [
      'external_profile_failed',
      'mcp_no_decoded_frames',
      'mcp_request_timeout',
      'visual_frame_missing',
      'visual_oracle_not_accepted',
    ],
  },
  proofId: 'external-rejection-proof:sha256:synthetic-bevy-name-only',
});

await writeJson(path.join(logsRoot, 'external-projects', 'explicit-bevy-wgsl-shader-material-rejection-proof.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_rejection.v1',
  profileId: 'explicit-bevy-wgsl-shader-material',
  proofMode: 'mcp_preview',
  backend: 'bevy_wgsl',
  backendFamily: 'wgpu_vulkan',
  libraryFamily: 'bevy',
  runtimeEnvironment: 'mcp_preview',
  profileClass: 'engine_asset_reload_visual_profile',
  status: 'fail',
  rejection: {
    accepted: false,
    reasons: [
      'external_profile_failed',
      'mcp_no_decoded_frames',
      'mcp_request_timeout',
      'visual_frame_missing',
      'visual_oracle_not_accepted',
    ],
  },
  proofId: 'external-rejection-proof:sha256:synthetic-bevy',
});

const externalVisualDir = path.join(logsRoot, 'external-projects', 'explicit-external-engine-visual');
await writeRgbaPng(path.join(externalVisualDir, 'before.png'), 320, 240, (x, y) => [
  (x * 3 + y) % 256,
  (x + y * 2) % 256,
  (32 + x + y) % 256,
  255,
]);
await writeRgbaPng(path.join(externalVisualDir, 'after.png'), 320, 240, (x, y) => [
  (80 + x * 5 + y) % 256,
  (48 + x + y * 3) % 256,
  (24 + x * 2 + y) % 256,
  255,
]);
await writeRgbaPng(path.join(externalVisualDir, 'diff.png'), 320, 240, (x, y) => [
  (255 - x + y) % 256,
  (180 + x * 2) % 256,
  (64 + y * 3) % 256,
  255,
]);
const externalVisualBefore = path.join(externalVisualDir, 'before.png');
const externalVisualAfter = path.join(externalVisualDir, 'after.png');
const externalVisualDiff = path.join(externalVisualDir, 'diff.png');
const externalVisualProfileSelection = {
  schemaVersion: 'synthi.gpu.hmr.external_profile_selection.v1',
  accepted: true,
  explicit: true,
  source: 'test_profile_path',
  profileId: 'explicit-external-engine-visual',
  profile_id: 'explicit-external-engine-visual',
  manifestHash: hashValue('explicit-external-engine-visual-manifest'),
  manifest_hash: hashValue('explicit-external-engine-visual-manifest'),
  path: 'profiles/explicit-external-engine-visual.json',
  evidenceRefs: ['test:external-profile-selection:explicit-path'],
  evidence_refs: ['test:external-profile-selection:explicit-path'],
};
const externalVisualSourceDeltaEvidence = {
  schemaVersion: 'synthi.gpu.hmr.external_source_delta_evidence.v1',
  accepted: true,
  sourceFile: 'src/material.frag',
  source_file: 'src/material.frag',
  sourcePath: 'external/src/material.frag',
  source_path: 'external/src/material.frag',
  matchCount: 1,
  match_count: 1,
  byteRange: { start: 128, end: 160 },
  byte_range: { start: 128, end: 160 },
  beforeFileHash: hashValue('explicit-external-engine-visual-before-file'),
  before_file_hash: hashValue('explicit-external-engine-visual-before-file'),
  afterFileHash: hashValue('explicit-external-engine-visual-after-file'),
  after_file_hash: hashValue('explicit-external-engine-visual-after-file'),
  beforeSnippetHash: hashValue('vec3 color = vec3(0.25);'),
  before_snippet_hash: hashValue('vec3 color = vec3(0.25);'),
  afterSnippetHash: hashValue('vec3 color = vec3(0.75);'),
  after_snippet_hash: hashValue('vec3 color = vec3(0.75);'),
  evidenceRefs: ['source:src/material.frag:unique-before-snippet'],
  evidence_refs: ['source:src/material.frag:unique-before-snippet'],
};
const externalVisualEvidenceArtifacts = [];
for (const artifactPath of [externalVisualBefore, externalVisualAfter, externalVisualDiff]) {
  const artifactBytes = await fs.readFile(artifactPath);
  const artifactHash = hashBuffer(artifactBytes);
  externalVisualEvidenceArtifacts.push({
    path: artifactPath,
    bytes: artifactBytes.length,
    contentHash: artifactHash,
    evidenceId: `evidence:visual-artifact:${artifactHash}`,
    evidence_id: `evidence:visual-artifact:${artifactHash}`,
    readError: null,
    read_error: null,
    visualAnalysisError: null,
    visual_analysis_error: null,
    width: 320,
    height: 240,
    visiblePixels: 76800,
    visible_pixels: 76800,
    visualQuality: 'gpu-hmr-visual-varied-frame',
    visual_quality: 'gpu-hmr-visual-varied-frame',
    acceptedAsVisualEvidence: true,
    accepted_as_visual_evidence: true,
    kind: 'visual-artifact',
    producerSubsystem: 'mcp.gpu_hmr_validation',
    producer_subsystem: 'mcp.gpu_hmr_validation',
  });
}
const externalVisualProofMaterial = {
  schemaVersion: 'synthi.gpu.hmr.external_visual_proof_artifact.v1',
  profileId: 'explicit-external-engine-visual',
  proofMode: 'external_runtime_screenshot',
  status: 'pass',
  createdAt: '2026-06-09T00:00:00.000Z',
  backend: 'webgl',
  backendFamily: 'webgl',
  backend_family: 'webgl',
  libraryFamily: 'threejs',
  library_family: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  runtime_environment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  profile_class: 'external_engine_visual_profile',
  profileSelection: externalVisualProfileSelection,
  profile_selection: externalVisualProfileSelection,
  sourceDeltaEvidence: externalVisualSourceDeltaEvidence,
  source_delta_evidence: externalVisualSourceDeltaEvidence,
  visualOracleArtifacts: {
    before_image: externalVisualBefore,
    after_image: externalVisualAfter,
    diff_image: externalVisualDiff,
    capture_backend: 'external_runtime_screenshot',
  },
  visualDiff: {
    changedPixelRatio: 0.5,
    meanAbsDelta8bit: 24,
    visiblePixelCount: 76800,
  },
  deterministicVisualMode: {
    frozen_camera: true,
    fixed_resolution: true,
    frame_capture_after_epoch_dispatch: true,
    presentation_fence_or_frame_boundary: true,
    seed_policy_fixed: true,
    temporal_accumulation_not_applicable: true,
    taa_not_applicable: true,
    denoiser_not_applicable: true,
  },
  deterministicVisualModeEvaluation: {
    accepted: true,
  },
  visualEvidenceArtifacts: externalVisualEvidenceArtifacts,
  acceptedVisualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
};
const externalVisualProofArtifact = {
  ...externalVisualProofMaterial,
  proofId: `external-visual-proof:${sha256Hex(stableJson(externalVisualProofMaterial))}`,
};
const externalVisualProofArtifactPath = path.join(
  logsRoot,
  'external-projects',
  'explicit-external-engine-visual-proof.json',
);
await writeJson(externalVisualProofArtifactPath, externalVisualProofArtifact);
await writeJson(path.join(logsRoot, 'external-projects', 'explicit-external-engine-visual-report.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_profile.report.v1',
  profile: {
    id: 'explicit-external-engine-visual',
    backend: 'webgl',
    backendFamily: 'webgl',
    libraryFamily: 'threejs',
    runtimeEnvironment: 'browser_dev_server',
    profileClass: 'external_engine_visual_profile',
  },
  proofMode: 'external_runtime_screenshot',
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  status: 'pass',
  profileSelection: externalVisualProfileSelection,
  profile_selection: externalVisualProfileSelection,
  sourceDeltaEvidence: externalVisualSourceDeltaEvidence,
  source_delta_evidence: externalVisualSourceDeltaEvidence,
  visualOracleArtifacts: {
    before_image: externalVisualBefore,
    after_image: externalVisualAfter,
    diff_image: externalVisualDiff,
    capture_backend: 'external_runtime_screenshot',
  },
  visualDiff: {
    changedPixelRatio: 0.5,
    meanAbsDelta8bit: 24,
    visiblePixelCount: 76800,
  },
  deterministicVisualModeEvaluation: {
    accepted: true,
  },
  visualProofArtifact: {
    schemaVersion: 'synthi.gpu.hmr.external_visual_proof_artifact.v1',
    proofId: externalVisualProofArtifact.proofId,
    path: externalVisualProofArtifactPath,
    visualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
    acceptedVisualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
    contentHashes: externalVisualEvidenceArtifacts.map((artifact) => artifact.contentHash),
  },
  proofArtifactPaths: [externalVisualProofArtifactPath],
  timings: {
    totalMs: 44,
    editToScreenshotMs: 12,
    visualDiffMs: 3,
  },
  proofId: 'external-profile-report:sha256:synthetic-engine-visual',
});

const forgedExternalVisualDir = path.join(logsRoot, 'external-projects', 'forged-external-engine-visual');
await writeRgbaPng(path.join(forgedExternalVisualDir, 'before.png'), 320, 240, (x, y) => [
  (x + y) % 256,
  (x * 2) % 256,
  (y * 3) % 256,
  255,
]);
await writeRgbaPng(path.join(forgedExternalVisualDir, 'after.png'), 320, 240, (x, y) => [
  (72 + x + y) % 256,
  (24 + x * 2) % 256,
  (96 + y * 3) % 256,
  255,
]);
await writeRgbaPng(path.join(forgedExternalVisualDir, 'diff.png'), 320, 240, (x, y) => [
  (255 - x) % 256,
  (255 - y) % 256,
  (x + y) % 256,
  255,
]);
await writeJson(path.join(logsRoot, 'external-projects', 'forged-external-engine-visual-report.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_profile.report.v1',
  profile: {
    id: 'forged-external-engine-visual',
    backend: 'webgl',
    backendFamily: 'webgl',
    libraryFamily: 'threejs',
    runtimeEnvironment: 'browser_dev_server',
    profileClass: 'external_engine_visual_profile',
  },
  proofMode: 'external_runtime_screenshot',
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  status: 'pass',
  visualOracleArtifacts: {
    before_image: path.join(forgedExternalVisualDir, 'before.png'),
    after_image: path.join(forgedExternalVisualDir, 'after.png'),
    diff_image: path.join(forgedExternalVisualDir, 'diff.png'),
    capture_backend: 'external_runtime_screenshot',
  },
  visualDiff: {
    changedPixelRatio: 0.5,
    meanAbsDelta8bit: 24,
    visiblePixelCount: 76800,
  },
  deterministicVisualModeEvaluation: {
    accepted: true,
  },
  proofId: 'external-profile-report:sha256:forged-engine-visual',
});

const noDeviceRuntimeCapabilityPreflight = {
  schemaVersion: 'synthi.real_rocm.array_allocation_capability.v1',
  backend: 'rocm',
  api: 'hipMallocArray',
  probe: 'hip_array_allocation_preflight',
  deviceCountResult: 100,
  deviceCountError: 'no ROCm-capable device is detected',
  deviceCount: 0,
  allocationResult: 100,
  allocationError: 'no ROCm-capable device is detected',
  allocationAvailable: false,
  allocationUnavailable: true,
  anyAllocationAvailable: false,
  allocationMatrixTotal: 8,
  allocationMatrixFailureCount: 8,
  textureResourceFallbackAvailable: false,
  textureResourceMatrixTotal: 4,
  textureResourceMatrixFailureCount: 4,
  exitCode: 70,
  degradedState: 'gpu-runtime-array-allocation-unavailable',
  degradedReason: 'HIP array allocation matrix failed 8/8 entries; no ROCm-capable device is detected',
};

const acceptedRuntimeCapabilityPreflight = {
  schemaVersion: 'synthi.real_rocm.array_allocation_capability.v1',
  backend: 'rocm',
  api: 'hipMallocArray',
  probe: 'hip_array_allocation_preflight',
  deviceCountResult: 0,
  deviceCount: 1,
  allocationResult: 0,
  allocationAvailable: true,
  anyAllocationAvailable: true,
  allocationMatrixTotal: 8,
  allocationMatrixFailureCount: 0,
  textureResourceFallbackAvailable: true,
  textureResourceMatrixTotal: 4,
  textureResourceMatrixFailureCount: 0,
  exitCode: 0,
  evidenceRefs: ['evidence:runtime-capability-preflight:accepted'],
};

function withAcceptedRuntimeCapabilityPreflight(materials = {}) {
  const camelRuntimeProofArtifact = materials.runtimeProofArtifact && typeof materials.runtimeProofArtifact === 'object'
    ? materials.runtimeProofArtifact
    : {};
  const snakeRuntimeProofArtifact = materials.runtime_proof_artifact && typeof materials.runtime_proof_artifact === 'object'
    ? materials.runtime_proof_artifact
    : camelRuntimeProofArtifact;
  return {
    ...materials,
    runtimeCapabilityPreflight: acceptedRuntimeCapabilityPreflight,
    runtime_capability_preflight: acceptedRuntimeCapabilityPreflight,
    runtimeProofArtifact: {
      ...camelRuntimeProofArtifact,
      runtimeCapabilityPreflight: acceptedRuntimeCapabilityPreflight,
      runtime_capability_preflight: acceptedRuntimeCapabilityPreflight,
    },
    runtime_proof_artifact: {
      ...snakeRuntimeProofArtifact,
      runtimeCapabilityPreflight: acceptedRuntimeCapabilityPreflight,
      runtime_capability_preflight: acceptedRuntimeCapabilityPreflight,
    },
  };
}

function realRocmRuntimeProofMaterials(scope, options = {}) {
  return withAcceptedRuntimeCapabilityPreflight(runtimeProofMaterials(scope, options));
}

function realRocmComputeProofLedgerMaterials(scope, options = {}) {
  return withAcceptedRuntimeCapabilityPreflight(computeProofLedgerMaterials(scope, options));
}

await writeJson(path.join(logsRoot, 'real-rocm-results.json'), {
  slug: 'gpu-real-rocm-large-lib-20260623',
  real_rocm_profile: {
    id: 'real-rocm-large-lib',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    source: 'scripts/profiles/real-rocm-large-lib.json',
  },
  source_url: 'https://example.invalid/rocm/large-lib.git',
  repo_commit: '0123456789abcdef0123456789abcdef01234567',
  entry_file: 'src/kernels/entry_kernel.hip',
  delta_file: 'src/kernels/activation_delta.h',
  target_name: 'LargeRocmDriver',
  gpu_vendor: 'rocm',
  gpu_arch: 'gfx1201',
  file_count: 12000,
  seeded_file_count: 11800,
  skipped_file_count: 200,
  full_runtime_proof_required: true,
  full_runtime_proven: false,
  gpu_hmr_success: false,
  runtime_capability_preflight: noDeviceRuntimeCapabilityPreflight,
  runtime_proof_artifact: null,
  proof_artifacts: [],
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'none',
    mode: 'none',
    sourceDerivedCandidateCount: 0,
    selectedSource: null,
    disabledReason: 'profile_disabled',
    contractPresent: false,
    runtimeProfilePresent: false,
    runtimeProfileSynced: false,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: '',
    phase: null,
    recognized: true,
    reason: 'phase_not_declared',
    targetName: 'LargeRocmDriver',
    finalAcceptanceTarget: 'LargeRocmDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    nonFinalPhase: false,
    nonFinalTargetRequired: false,
    requirements: [],
  },
  target_progression_gates: [
    {
      name: 'target progression phase',
      status: 'fail',
      detail: 'target progression phase is required but was not declared',
    },
  ],
  real_rocm_profile_proof_obligations: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations_facet.v1',
    status: 'profile_proof_obligations_unmet',
    proofAuthority: 'profile_configuration_gate_not_runtime_proof',
    proof_authority: 'profile_configuration_gate_not_runtime_proof',
    declared: false,
    refusalOnly: false,
    refusal_only: false,
    progressionRequired: true,
    progression_required: true,
    finalAcceptance: true,
    final_acceptance: true,
    requiresFullRuntimeProof: true,
    requires_full_runtime_proof: true,
    fullRuntimeProofRequested: true,
    full_runtime_proof_requested: true,
    requiresOutputOracle: true,
    requires_output_oracle: true,
    outputOraclePresent: false,
    output_oracle_present: false,
    blockingGaps: ['proof_obligation_output_oracle_profile_missing'],
    blocking_gaps: ['proof_obligation_output_oracle_profile_missing'],
  },
  real_rocm_app_hook_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_contract_facet.v1',
    declared: false,
    required: true,
    status: 'required_app_hook_contract_missing',
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    contractEvidenceComplete: false,
    contract_evidence_complete: false,
    runtimeObservationComplete: false,
    runtime_observation_complete: false,
    blockingGaps: [
      'app_hook_contract_not_declared',
      'app_hook_artifact_transport_evidence_missing',
      'app_hook_epoch_publication_evidence_missing',
      'app_hook_dispatch_trace_evidence_missing',
      'app_hook_host_identity_evidence_missing',
      'app_hook_output_oracle_evidence_missing',
    ],
    blocking_gaps: [
      'app_hook_contract_not_declared',
      'app_hook_artifact_transport_evidence_missing',
      'app_hook_epoch_publication_evidence_missing',
      'app_hook_dispatch_trace_evidence_missing',
      'app_hook_host_identity_evidence_missing',
      'app_hook_output_oracle_evidence_missing',
    ],
  },
  real_rocm_device_sidecar_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract_facet.v1',
    declared: false,
    required: false,
    status: 'derived_device_sidecar_candidate_not_runtime_proof',
    proofAuthority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    proof_authority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: false,
    runtime_observation_complete: false,
    sourceCoverageComplete: true,
    source_coverage_complete: true,
    backend: 'hip',
    artifact_identity: {
      source_paths: ['src/kernels/entry_kernel.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['entry_kernel'],
      compile_target: 'gfx1201',
      compiler: '/opt/rocm/llvm/bin/amdclang++',
      compiler_args_hash: hashValue('large-rocm-device-sidecar-compile-args'),
    },
    blockingGaps: [
      'device_sidecar_artifact_transport_runtime_not_observed',
      'device_sidecar_epoch_publication_runtime_not_observed',
      'device_sidecar_dispatch_trace_runtime_not_observed',
      'device_sidecar_output_oracle_runtime_not_observed',
      'device_sidecar_host_identity_runtime_not_observed',
    ],
    blocking_gaps: [
      'device_sidecar_artifact_transport_runtime_not_observed',
      'device_sidecar_epoch_publication_runtime_not_observed',
      'device_sidecar_dispatch_trace_runtime_not_observed',
      'device_sidecar_output_oracle_runtime_not_observed',
      'device_sidecar_host_identity_runtime_not_observed',
    ],
  },
  real_rocm_sidecar_runtime_consistency: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1',
    status: 'sidecar_runtime_backend_consistent_not_runtime_proof',
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sidecarBackend: 'hip',
    sidecar_backend: 'hip',
    runtimeBackendCandidates: ['hip'],
    runtime_backend_candidates: ['hip'],
    backendConsistent: true,
    backend_consistent: true,
    blockingGaps: ['sidecar_runtime_sidecar_observation_missing'],
    blocking_gaps: ['sidecar_runtime_sidecar_observation_missing'],
  },
  strict_proof_gates: {
    schemaVersion: 'synthi.gpu_hmr.strict_proof_gates.v1',
    name: 'strict runtime proof artifact presence',
    status: 'fail',
    accepted: false,
    failures: ['runtime_proof_artifact_missing'],
  },
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-large-lib-delta',
    editHash: hashValue('real-rocm-large-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/large-lib.git @ 0123456789ab files=12000' },
    { name: 'compile projection', status: 'pass', detail: 'real_repo_user_source_delta_hmr selected=120 bytes=1000000 omitted=11880' },
    {
      name: 'real_repo_user_source_delta_hmr',
      status: 'warn',
      detail: `provisional_wait_terminal=true gpu_proof=missing ${JSON.stringify({
        name: 'real_repo_user_source_delta_hmr',
        wait_hmr_status: 'timeout',
        gpu_proof_validation: {
          requiredState: 'gpu-hmr-full-runtime-proven',
          satisfied: false,
          reason: 'proof_state_missing',
        },
      })}`,
    },
    { name: 'strict runtime proof artifact presence', status: 'fail', detail: 'failures=runtime_proof_artifact_missing' },
  ],
});

const originalHostPreflightRocmDir = path.join(logsRoot, 'real-rocm-original-host-preflight');
await writeJson(path.join(originalHostPreflightRocmDir, 'real-rocm-original-host-preflight.json'), {
  slug: 'gpu-real-rocm-original-host-preflight-20260623',
  real_rocm_profile: { id: 'real-rocm-original-host-preflight' },
  source_url: 'https://example.invalid/rocm/original-host-preflight.git',
  repo_commit: '0123456789abcdef0123456789abcdef01234567',
  entry_file: 'src/kernels/original_host_preflight.hip',
  delta_file: 'src/kernels/original_host_preflight.hip',
  target_name: 'OriginalHostPreflightDriver',
  gpu_vendor: 'rocm',
  full_runtime_proven: false,
  gpu_hmr_success: false,
  originalHostPathProof: {
    runtimeCapabilityPreflightObserved: true,
    runtimeCapabilityPreflight: noDeviceRuntimeCapabilityPreflight,
  },
  checks: [
    {
      name: 'real ROCm repo',
      status: 'pass',
      detail: 'https://example.invalid/rocm/original-host-preflight.git @ 0123456789ab files=2000',
    },
    {
      name: 'real_repo_user_source_delta_hmr',
      status: 'warn',
      detail: JSON.stringify({
        wait_hmr_status: 'timeout',
        gpu_proof_validation: { reason: 'proof_state_missing', satisfied: false },
      }),
    },
  ],
});

await writeJson(path.join(artifactsRoot, 'webgpu-runtime-visual-proof', 'forged-webgpu-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu' },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});

const forgedWebGpuVisualDir = path.join(artifactsRoot, 'webgpu-runtime-visual-proof');
await writeRgbaPng(path.join(forgedWebGpuVisualDir, 'forged-before.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(forgedWebGpuVisualDir, 'forged-after.png'), 8, 8, (x, y) => [32 + x, 48 + y, 64, 255]);
await writeRgbaPng(path.join(forgedWebGpuVisualDir, 'forged-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-query-only-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:query-only-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-query-only' },
  visualOracleArtifacts: {
    beforeImage: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    afterImage: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
    diffImage: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
  },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
  proofLedgerQuery: {
    schemaVersion: 'synthi.gpu.hmr.proof_ledger_query.v1',
    proofId: 'gpu-ledger-proof:sha256:forged-query-only',
    gpuHmrSuccess: true,
    failedInvariants: [],
  },
});

await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-source-adapted-visual-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:source-adapted-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-source-adapted-visual' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list',
    },
  },
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-source-adapted-visual',
    visualRoot: forgedWebGpuVisualDir,
  }),
  visualOracleArtifacts: {
    beforeImage: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    afterImage: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
    diffImage: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
  },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  runtimeProbeInstrumentation: {
    sourceAdaptations: [
      'runtime_capture_hook_inserted',
      'application_render_state_reset_hook_inserted',
    ],
    adaptedOrAlreadyPresent: true,
  },
  runtime_probe_instrumentation: {
    source_adaptations: [
      'runtime_capture_hook_inserted',
      'application_render_state_reset_hook_inserted',
    ],
    adapted_or_already_present: true,
  },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});

await writeJson(path.join(artifactsRoot, 'webgpu-runtime-compute-proof', 'forged-webgpu-compute-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_compute_proof.v1',
  proofId: 'webgpu-runtime-compute-proof:sha256:forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-compute' },
  computeOracleValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  contract: {
    webgpu_contract: {
      pipeline_kind: 'compute',
      supported_pipeline_scope: 'explicit-compute-profiled-layout-storage-uniform-float32-readback',
    },
  },
});

const hiprtDir = path.join(artifactsRoot, 'hiprt-light-math-warm-proof');
const hiprtAcceptedBefore = path.join(hiprtDir, 'accepted-before.png');
const hiprtAcceptedAfter = path.join(hiprtDir, 'accepted-after.png');
const hiprtAcceptedDiff = path.join(hiprtDir, 'accepted-diff.png');
await writeRgbaPng(hiprtAcceptedBefore, 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(hiprtAcceptedAfter, 8, 8, (x, y) => [24 + x, 32 + y, 48 + x + y, 255]);
await writeRgbaPng(hiprtAcceptedDiff, 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(hiprtDir, 'accepted-hiprt-proof.json'), hiprtWarmProofArtifact({
  slug: 'accepted-hiprt-recomputed-oracle',
  profileId: 'accepted-hiprt-recomputed-oracle',
  baselinePath: hiprtAcceptedBefore,
  changedPath: hiprtAcceptedAfter,
  diffPath: hiprtAcceptedDiff,
  oracleRegionClaimNonBlank: true,
}));
await writeJson(path.join(hiprtDir, 'accepted-hiprt-cold.json'), {
  ...runModeProofBase,
  backend: 'hiprt',
  targetId: 'accepted-hiprt-recomputed-oracle',
  profileId: 'accepted-hiprt-recomputed-oracle',
  runtimeProbeInstrumentation: hiprtRuntimeProbeInstrumentation('accepted-hiprt-recomputed-oracle'),
  runtime_probe_instrumentation: hiprtRuntimeProbeInstrumentation('accepted-hiprt-recomputed-oracle'),
  coverageObligations: { perTargetRunModes: false },
  proofId: 'agent-split-run-mode-proof:sha256:accepted-hiprt-cold',
  coldSplitProven: true,
  cold_split_proven: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  visualArtifacts: {
    beforeImage: hiprtAcceptedBefore,
    afterImage: hiprtAcceptedAfter,
    diffImage: hiprtAcceptedDiff,
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split',
    editHash: 'sha256:accepted-hiprt-cold',
    editKind: 'cold_split',
  },
});
await writeJson(path.join(hiprtDir, 'accepted-hiprt-hot2.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:accepted-hiprt-hot2', 'gpu-runtime-proof:sha256:accepted-hiprt-hot2'),
  ...runtimeProofMaterials('hot_delta_2', {
    projectId: 'accepted-hiprt-recomputed-oracle',
    visualRoot: hiprtDir,
    sourceAdaptedVisualProfile: true,
  }),
  backend: 'hiprt',
  targetId: 'accepted-hiprt-recomputed-oracle',
  profileId: 'accepted-hiprt-recomputed-oracle',
  runtimeProbeInstrumentation: hiprtRuntimeProbeInstrumentation('accepted-hiprt-recomputed-oracle'),
  runtime_probe_instrumentation: hiprtRuntimeProbeInstrumentation('accepted-hiprt-recomputed-oracle'),
  coverageObligations: { perTargetRunModes: false },
  proofId: 'agent-split-run-mode-proof:sha256:accepted-hiprt-hot2',
  acceptedForGpuHmr: false,
  visualProfileAccepted: true,
  sourceAdaptedProfile: true,
  gpuHmrSuccess: false,
  visualArtifacts: {
    beforeImage: hiprtAcceptedBefore,
    afterImage: hiprtAcceptedAfter,
    diffImage: hiprtAcceptedDiff,
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:accepted-hiprt-hot2',
    editHash: 'sha256:accepted-hiprt-hot2',
    editKind: 'different_gpu_edit',
    differentEdit: true,
  },
});

await writeJson(path.join(hiprtDir, 'forged-hiprt-missing-instrumentation-hot.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:forged-hiprt-missing-instrumentation',
    'gpu-runtime-proof:sha256:forged-hiprt-missing-instrumentation',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-hiprt-missing-instrumentation',
    visualRoot: hiprtDir,
  }),
  backend: 'hiprt',
  targetId: 'forged-hiprt-missing-instrumentation',
  profileId: 'forged-hiprt-missing-instrumentation',
  coverageObligations: { perTargetRunModes: false },
  proofId: 'agent-split-run-mode-proof:sha256:forged-hiprt-missing-instrumentation',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: hiprtAcceptedBefore,
    afterImage: hiprtAcceptedAfter,
    diffImage: hiprtAcceptedDiff,
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:forged-hiprt-missing-instrumentation',
    editHash: 'sha256:forged-hiprt-missing-instrumentation',
    editKind: 'gpu_artifact_edit',
  },
});

const hiprtForgedBefore = path.join(hiprtDir, 'forged-before.png');
const hiprtForgedAfter = path.join(hiprtDir, 'forged-after.png');
const hiprtForgedDiff = path.join(hiprtDir, 'forged-diff.png');
await writeRgbaPng(hiprtForgedBefore, 8, 8, (x, y) => [24 + x, 32 + y, 48 + x + y, 255]);
await writeRgbaPng(hiprtForgedAfter, 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(hiprtForgedDiff, 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(hiprtDir, 'forged-hiprt-proof.json'), hiprtWarmProofArtifact({
  slug: 'forged-hiprt-oracle-region-json',
  profileId: 'forged-hiprt-oracle-region-json',
  baselinePath: hiprtForgedBefore,
  changedPath: hiprtForgedAfter,
  diffPath: hiprtForgedDiff,
  oracleRegionClaimNonBlank: true,
}));

const truncatedVisualDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-truncated-visual');
await writePng(path.join(truncatedVisualDir, 'before-hmr-first.png'));
await writePng(path.join(truncatedVisualDir, 'after-hmr-first.png'));
await writePng(path.join(truncatedVisualDir, 'before-after-diff.png'));
await writeJson(path.join(truncatedVisualDir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:truncated-visual-hot1', 'gpu-runtime-proof:sha256:truncated-visual-hot1'),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'truncated-visual',
    visualRoot: truncatedVisualDir,
  }),
  targetId: 'truncated-visual',
  profileId: 'truncated-visual',
  proofId: 'agent-split-run-mode-proof:sha256:truncated-visual-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(truncatedVisualDir, 'before-hmr-first.png'),
    afterImage: path.join(truncatedVisualDir, 'after-hmr-first.png'),
    diffImage: path.join(truncatedVisualDir, 'before-after-diff.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:truncated-visual-hot1',
    editHash: 'sha256:truncated-visual-hot1',
    editKind: 'gpu_artifact_edit',
  },
});

const noVisualOptOutDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-no-visual-optout');
await writeJson(path.join(noVisualOptOutDir, 'hot1.json'), {
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  ...waitProofValidation('gpu-ledger-proof:sha256:no-visual-optout-hot1', 'gpu-runtime-proof:sha256:no-visual-optout-hot1'),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'no-visual-optout',
    visualRoot: noVisualOptOutDir,
  }),
  backend: 'hip',
  targetId: 'no-visual-optout',
  profileId: 'no-visual-optout',
  proofId: 'agent-split-run-mode-proof:sha256:no-visual-optout-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualRequired: false,
  visual_required: false,
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:no-visual-optout-hot1',
    editHash: 'sha256:no-visual-optout-hot1',
    editKind: 'gpu_artifact_edit',
  },
});

const ledger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [logsRoot, artifactsRoot],
  generatedAt: '2026-06-09T00:00:00.000Z',
  includeUnproven: true,
});

assert.equal(ledger.schemaVersion, GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION);
assert.equal(ledger.query.accepted, true);
assert.ok(ledger.proofId.startsWith('gpu-validation-matrix-ledger:sha256:'));

const acceptedFlow = ledger.rows.find((row) =>
  row.targetId === 'flow'
    && row.matrixOutcome === 'full_runtime_gpu_hmr'
    && row.runMode?.metricScope === 'hot_delta_1'
);
assert.equal(acceptedFlow?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedFlow.acceptedForGpuHmr, true);
assert.equal(acceptedFlow.visual.accepted, true);
assert.equal(acceptedFlow.visual.allImagesAreDecodedPng, true);
assert.equal(acceptedFlow.visual.decodedImageCount, 3);
assert.equal(acceptedFlow.runMode.accepted, true);
assert.equal(acceptedFlow.runMode.metricScope, 'hot_delta_1');
assert.equal(acceptedFlow.visual.changedPixelRatio, 0.042);
assert.ok(acceptedFlow.ledger.proofId.startsWith('gpu-ledger-proof:sha256:'));
assert.equal(acceptedFlow.ledger.source, 'recomputed_ledger');
assert.equal(acceptedFlow.runtimeProofArtifact.accepted, true);
assert.equal(acceptedFlow.generalityClaim.schemaVersion, 'synthi.gpu_hmr.generality_claim.v1');
assert.equal(acceptedFlow.generalityClaim.profileScopedOnly, true);
assert.equal(acceptedFlow.generalityClaim.broadLibraryAgnosticAccepted, false);
assert.equal(acceptedFlow.generalityClaim.arbitraryLibraryAccepted, false);
assert.equal(acceptedFlow.generalityClaim.arbitraryTargetRuntimeAccepted, false);
assert.ok(acceptedFlow.generalityClaim.unsupportedWithoutEvidence.length > 0);

const strictMissingArtifact = ledger.rows.find((row) => row.targetId === 'strict-runtime-missing-artifact');
assert.equal(strictMissingArtifact?.proofMode, 'strict_runtime_ledger');
assert.equal(strictMissingArtifact.matrixOutcome, 'unproven');
assert.equal(strictMissingArtifact.acceptedForGpuHmr, false);
assert.equal(strictMissingArtifact.gpuHmrSuccess, false);
assert.equal(strictMissingArtifact.ledger.gpuHmrSuccess, true);
assert.equal(strictMissingArtifact.runtimeProofArtifact.present, false);
assert.equal(strictMissingArtifact.runtimeProofArtifact.accepted, false);
assert.ok(strictMissingArtifact.reasons.includes('runtime_proof_artifact_not_strictly_accepted'));
assert.ok(strictMissingArtifact.openGaps.includes('runtime_proof_artifact_missing'));

const strictComputeMissingReadback = ledger.rows.find((row) =>
  row.targetId === 'strict-runtime-compute-missing-readback'
);
assert.equal(strictComputeMissingReadback?.proofMode, 'strict_runtime_ledger');
assert.equal(strictComputeMissingReadback.matrixOutcome, 'unproven');
assert.equal(strictComputeMissingReadback.acceptedForGpuHmr, false);
assert.equal(strictComputeMissingReadback.gpuHmrSuccess, false);
assert.equal(strictComputeMissingReadback.ledger.gpuHmrSuccess, true);
assert.equal(strictComputeMissingReadback.runtimeProofArtifact.accepted, true);
assert.equal(strictComputeMissingReadback.outputOracleFacet.kind, 'compute_oracle');
assert.equal(strictComputeMissingReadback.outputOracleFacet.accepted, false);
assert.equal(strictComputeMissingReadback.outputOracleFacet.compute.present, true);
assert.equal(strictComputeMissingReadback.outputOracleFacet.compute.rawReadbackHashVerified, false);
assert.ok(strictComputeMissingReadback.outputOracleFacet.compute.rawReadbackReadError);
assert.ok(strictComputeMissingReadback.reasons.includes('compute_oracle_files_not_accepted'));
assert.ok(strictComputeMissingReadback.reasons.includes('compute_oracle_raw_readback_hash_unverified'));
assert.ok(strictComputeMissingReadback.openGaps.includes('compute_oracle_raw_readback_unreadable'));

function acceptedMatrixRowMissingFirewall(targetId, firewallFields = {}) {
  return {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    rowId: `gpu-validation-matrix-row:sha256:${sha256Hex(`missing-firewall:${targetId}`)}`,
    backend: 'hip',
    targetId,
    proofMode: 'strict_runtime_ledger',
    matrixOutcome: 'full_runtime_gpu_hmr',
    acceptedForGpuHmr: true,
    gpuHmrSuccess: true,
    proofChainAccepted: true,
    acceptanceScope: 'rocm_hip_declared_runtime_profile',
    claimScope: 'scoped_profile',
    ledger: {
      present: true,
      source: 'recomputed_ledger',
      gpuHmrSuccess: true,
      failedInvariants: [],
    },
    runtimeProofArtifact: {
      present: true,
      accepted: true,
      failedGates: [],
    },
    visual: {
      required: false,
      accepted: true,
    },
    ...firewallFields,
  };
}

function acceptedAuthoritativeMatrixRow(targetId, fields = {}) {
  const row = JSON.parse(JSON.stringify(acceptedFlow));
  return {
    ...row,
    targetId,
    profileId: targetId,
    ...fields,
  };
}

function mutateAcceptedLedgerRecord(row, mutate) {
  const cloned = JSON.parse(JSON.stringify(row));
  mutate(cloned.ledger.record, cloned);
  return cloned;
}

const missingStrictRuntimeArtifactQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-missing-strict-runtime-artifact', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
      runtimeProofArtifact: {
        present: false,
        accepted: false,
        failedGates: [{ code: 'runtime_proof_artifact_missing' }],
      },
    }),
  ],
});
assert.equal(missingStrictRuntimeArtifactQuery.accepted, false);
assert.equal(missingStrictRuntimeArtifactQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(missingStrictRuntimeArtifactQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_strict_runtime_proof_artifact'
));

const missingGeneralityClaimRow = acceptedAuthoritativeMatrixRow('accepted-missing-generality-claim');
delete missingGeneralityClaimRow.generalityClaim;
delete missingGeneralityClaimRow.generality_claim;
const missingGeneralityClaimQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [missingGeneralityClaimRow],
});
assert.equal(missingGeneralityClaimQuery.accepted, false);
assert.equal(missingGeneralityClaimQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(missingGeneralityClaimQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_generality_claim_facet'
));

const forgedGeneralityClaimQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-forged-generality-claim', {
      generalityClaim: {
        ...acceptedFlow.generalityClaim,
        arbitraryLibraryAccepted: true,
        arbitrary_library_accepted: true,
      },
      generality_claim: {
        ...acceptedFlow.generalityClaim,
        arbitraryLibraryAccepted: true,
        arbitrary_library_accepted: true,
      },
    }),
  ],
});
assert.equal(forgedGeneralityClaimQuery.accepted, false);
assert.equal(forgedGeneralityClaimQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(forgedGeneralityClaimQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_generality_claim_arbitrary_library_mismatch'
));

const missingFirewallQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-missing-cpu-firewall', {
      fullRebuildUsed: false,
      processRestarted: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-missing-full-rebuild-firewall', {
      cpuHmrUsed: false,
      processRestarted: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-missing-process-restart-firewall', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-null-cpu-firewall', {
      cpuHmrUsed: null,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-null-full-rebuild-firewall', {
      cpuHmrUsed: false,
      fullRebuildUsed: null,
      processRestarted: false,
    }),
    acceptedMatrixRowMissingFirewall('accepted-null-process-restart-firewall', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: null,
    }),
  ],
});
assert.equal(missingFirewallQuery.accepted, false);
for (const expectedGate of [
  'gpu_hmr_success_requires_cpu_hmr_false',
  'gpu_hmr_success_requires_full_rebuild_false',
  'gpu_hmr_success_requires_process_restart_false',
]) {
  assert.ok(
    missingFirewallQuery.failedGates.some((gate) => gate.code === expectedGate),
    `expected validation matrix safety gate ${expectedGate}`,
  );
}
const missingLedgerAuthorityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-missing-ledger-authority', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(missingLedgerAuthorityQuery.accepted, false);
assert.equal(missingLedgerAuthorityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
for (const expectedGate of [
  'gpu_hmr_success_requires_ledger_proof_id',
  'gpu_hmr_success_requires_proof_ledger_record',
  'gpu_hmr_success_requires_ledger_record_proof_id',
  'gpu_hmr_success_requires_complete_ledger_record',
]) {
  assert.ok(
    missingLedgerAuthorityQuery.failedGates.some((gate) => gate.code === expectedGate),
    `expected validation matrix ledger authority gate ${expectedGate}`,
  );
}
const missingLedgerProofRefQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-ledger-proof-id-not-referenced', {
      proofIds: [],
    }),
  ],
});
assert.equal(missingLedgerProofRefQuery.accepted, false);
assert.equal(missingLedgerProofRefQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(missingLedgerProofRefQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_ledger_proof_id_in_row_proof_ids'
));
const forgedRecordCpuFallbackQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    mutateAcceptedLedgerRecord(
      acceptedAuthoritativeMatrixRow('accepted-ledger-record-cpu-fallback'),
      (record) => {
        record.cpuHmrUsed = true;
      },
    ),
  ],
});
assert.equal(forgedRecordCpuFallbackQuery.accepted, false);
assert.equal(forgedRecordCpuFallbackQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(forgedRecordCpuFallbackQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_recomputed_ledger_record_success'
));
assert.ok(forgedRecordCpuFallbackQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_zero_recomputed_ledger_record_invariants'
  && gate.invariantCodes?.includes('cpu_hmr_used')
));
const acceptedRowSuccessFlagMismatchQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-row-success-flag-false', {
      gpuHmrSuccess: false,
    }),
  ],
});
assert.equal(acceptedRowSuccessFlagMismatchQuery.accepted, false);
assert.ok(acceptedRowSuccessFlagMismatchQuery.failedGates.some((gate) =>
  gate.code === 'accepted_gpu_hmr_row_requires_gpu_hmr_success_true'
));
const acceptedRowRefusalMismatchQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-row-refusal-proven', {
      refusalProven: true,
    }),
  ],
});
assert.equal(acceptedRowRefusalMismatchQuery.accepted, false);
assert.ok(acceptedRowRefusalMismatchQuery.failedGates.some((gate) =>
  gate.code === 'accepted_gpu_hmr_row_cannot_be_refusal_proven'
));
const sourceAdaptedFirewallQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-source-adapted-row', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
      sourceAdaptedProfile: true,
      sourceAdaptation: {
        sourceAdaptedProfile: true,
        sourceAdaptations: ['test-only source rewrite disclosed by runtime probe'],
        failedGates: [{ code: 'source_adapted_profile_not_no_shim_gpu_hmr' }],
      },
    }),
  ],
});
assert.equal(sourceAdaptedFirewallQuery.accepted, false);
assert.equal(sourceAdaptedFirewallQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(sourceAdaptedFirewallQuery.failedGates.some((gate) =>
  gate.code === 'source_adapted_profile_not_no_shim_gpu_hmr'
));
const unknownAcceptanceScopeQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-unknown-acceptance-scope', {
      acceptanceScope: 'vendor_runtime_claim_without_declared_scope',
      claimScope: 'unknown_scope',
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(unknownAcceptanceScopeQuery.accepted, false);
assert.ok(unknownAcceptanceScopeQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_known_acceptance_scope'
));
const forgedBroadScopeQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-forged-broad-acceptance-scope', {
      acceptanceScope: 'broad_library_agnostic',
      claimScope: 'broad_library_agnostic',
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(forgedBroadScopeQuery.accepted, false);
assert.equal(forgedBroadScopeQuery.summary.broadFullRuntimeGpuHmrRows, 0);
assert.equal(forgedBroadScopeQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(forgedBroadScopeQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_broad_library_agnostic_scope_proof'
));
assert.ok(forgedBroadScopeQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_known_acceptance_scope'
));
assert.equal(
  forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.authority,
  'matrix_computed_not_row_declared',
);
assert.equal(forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.accepted, false);
const forgedBroadScopeWithFacetQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-forged-broad-acceptance-scope-with-facet', {
      acceptanceScope: 'broad_library_agnostic',
      claimScope: 'broad_library_agnostic',
      broadLibraryAgnosticProof: {
        accepted: true,
        recomputedFromLedger: true,
        evidenceRefs: ['ledger:a', 'ledger:b'],
        backendScopes: ['hip', 'hiprt', 'webgpu', 'opencl'],
        libraryFamilies: ['generated', 'engine', 'large-rocm'],
        environmentClasses: ['local-rocm'],
        negativeRefusalProofs: ['refusal:a'],
        outputOracleProofs: ['oracle:a'],
      },
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(forgedBroadScopeWithFacetQuery.accepted, false);
assert.equal(forgedBroadScopeWithFacetQuery.summary.broadFullRuntimeGpuHmrRows, 0);
assert.equal(forgedBroadScopeWithFacetQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(forgedBroadScopeWithFacetQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_broad_library_agnostic_scope_proof'
));
assert.ok(forgedBroadScopeWithFacetQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_known_acceptance_scope'
));
const validScopedSummaryQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-scoped-summary-row'),
  ],
});
assert.equal(validScopedSummaryQuery.accepted, true);
const inflatedSummaryQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedAuthoritativeMatrixRow('accepted-scoped-summary-row'),
  ],
  summary: {
    ...validScopedSummaryQuery.summary,
    acceptedFullRuntimeClaimScopeBreakdown: { broad_library_agnostic: 1 },
    broadFullRuntimeGpuHmrRows: 1,
    broadFullRuntimeTargets: ['accepted-scoped-summary-row'],
  },
});
assert.equal(inflatedSummaryQuery.accepted, false);
assert.ok(inflatedSummaryQuery.failedGates.some((gate) =>
  gate.code === 'validation_matrix_summary_mismatch'
));
const missingRequiredHookSafetyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    {
      ...acceptedMatrixRowMissingFirewall('accepted-missing-required-app-hook', {
        cpuHmrUsed: false,
        fullRebuildUsed: false,
        processRestarted: false,
      }),
      proofMode: 'real_rocm_repo_validation',
      realRocmProfileProofObligations: {
        requiresAppHookContract: true,
        requires_app_hook_contract: true,
        blockingGaps: [],
        blocking_gaps: [],
      },
    },
  ],
});
assert.equal(missingRequiredHookSafetyQuery.accepted, false);
assert.ok(missingRequiredHookSafetyQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_real_rocm_app_hook_contract'
));
const failedRuntimeCapabilityPreflightSafetyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    {
      ...acceptedMatrixRowMissingFirewall('accepted-failed-runtime-capability-preflight', {
        cpuHmrUsed: false,
        fullRebuildUsed: false,
        processRestarted: false,
      }),
      proofMode: 'real_rocm_repo_validation',
      realRocmRuntimeCapabilityPreflight: {
        schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_capability_preflight_facet.v1',
        present: true,
        accepted: false,
        blockingGaps: ['runtime_device_unavailable'],
        blocking_gaps: ['runtime_device_unavailable'],
      },
    },
  ],
});
assert.equal(failedRuntimeCapabilityPreflightSafetyQuery.accepted, false);
assert.ok(failedRuntimeCapabilityPreflightSafetyQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_cannot_have_failed_real_rocm_runtime_capability_preflight'
));
const missingRuntimeCapabilityPreflightSafetyQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    {
      ...acceptedMatrixRowMissingFirewall('accepted-missing-runtime-capability-preflight', {
        cpuHmrUsed: false,
        fullRebuildUsed: false,
        processRestarted: false,
      }),
      proofMode: 'real_rocm_repo_validation',
      realRocmRuntimeCapabilityPreflight: {
        schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_capability_preflight_facet.v1',
        present: false,
        accepted: null,
        blockingGaps: [],
        blocking_gaps: [],
      },
    },
  ],
});
assert.equal(missingRuntimeCapabilityPreflightSafetyQuery.accepted, false);
assert.ok(missingRuntimeCapabilityPreflightSafetyQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_real_rocm_runtime_capability_preflight'
));

const opencl = ledger.rows.find((row) => row.backend === 'opencl');
assert.equal(opencl?.matrixOutcome, 'refusal_proven');
assert.equal(opencl.acceptedForGpuHmr, false);
assert.equal(opencl.gpuHmrSuccess, false);
assert.equal(opencl.refusalProven, true);
assert.equal(opencl.backendEvidence.accepted, true);
assert.equal(opencl.backendEvidence.backend, 'opencl');
assert.equal(opencl.backendEvidence.backendFamily, 'opencl');
assert.deepEqual(opencl.backendEvidence.evidenceRefs, [openClPreflightEvidenceRef]);

const legacySchemaOnlyPreflightLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [legacySchemaOnlyPreflightDir],
  generatedAt: '2026-06-09T00:00:00.050Z',
  includeUnproven: true,
});
const legacySchemaOnlyPreflight = legacySchemaOnlyPreflightLedger.rows.find(
  (row) => row.targetId === 'legacy-schema-only-opencl-preflight',
);
assert.equal(legacySchemaOnlyPreflight?.backend, 'unknown');
assert.equal(legacySchemaOnlyPreflight.matrixOutcome, 'unproven');
assert.equal(legacySchemaOnlyPreflight.acceptedForGpuHmr, false);
assert.equal(legacySchemaOnlyPreflight.proofChainAccepted, false);
assert.equal(legacySchemaOnlyPreflight.backendEvidence.accepted, false);
assert.ok(legacySchemaOnlyPreflight.reasons.includes('preflight_typed_backend_evidence_required'));
assert.ok(legacySchemaOnlyPreflight.openGaps.includes('preflight_typed_backend_evidence_required'));
const legacySchemaOnlyPreflightCoverage = new Map(
  legacySchemaOnlyPreflightLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(legacySchemaOnlyPreflightCoverage.get('opencl_dispatch_readback')?.status, 'missing');
const forgedPreflightBackendCoverageQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [{
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    artifactSchema: 'synthi.gpu_hmr.opencl_preflight.v1',
    artifactPath: 'synthetic/schema-only-opencl-preflight.json',
    updatedAt: '2026-06-09T00:00:00.050Z',
    backend: 'opencl',
    targetId: 'forged-schema-only-opencl-preflight',
    profileId: 'forged-schema-only-opencl-preflight',
    proofMode: 'runtime_preflight',
    evidenceKind: 'runtime_preflight_refusal',
    matrixOutcome: 'refusal_proven',
    acceptanceClass: 'refusal_proven',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven: true,
    proofChainAccepted: true,
    proofChain: 'structured_runtime_refusal',
    proofIds: ['opencl-preflight-proof:sha256:forged-schema-only'],
    ledger: {
      present: false,
      proofId: null,
      gpuHmrSuccess: false,
      failedInvariants: [],
    },
    reasons: [],
    openGaps: [],
  }],
});
assert.equal(forgedPreflightBackendCoverageQuery.accepted, false);
assert.ok(forgedPreflightBackendCoverageQuery.failedGates.some((gate) =>
  gate.code === 'preflight_backend_specific_classification_requires_typed_backend_evidence'
));
const forgedPreflightBackendCoverage = new Map(
  forgedPreflightBackendCoverageQuery.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(forgedPreflightBackendCoverage.get('opencl_dispatch_readback')?.status, 'missing');

const bevy = ledger.rows.find((row) => row.backend === 'bevy_wgsl');
assert.equal(bevy?.matrixOutcome, 'refusal_proven');
assert.equal(bevy.acceptedForGpuHmr, false);
assert.equal(bevy.externalProjectContract.accepted, true);
assert.equal(bevy.externalProjectContract.profileClass, 'engine_asset_reload_visual_profile');
assert.ok(bevy.reasons.includes('mcp_no_decoded_frames'));
assert.ok(bevy.reasons.includes('mcp_request_timeout'));
assert.ok(bevy.reasons.includes('visual_frame_missing'));

const bevyNameOnly = ledger.rows.find((row) => row.targetId === 'bevy-wgsl-name-only');
assert.equal(bevyNameOnly?.matrixOutcome, 'refusal_proven');
assert.equal(bevyNameOnly.backend, 'unknown');
assert.equal(bevyNameOnly.externalProjectContract.accepted, false);
assert.ok(bevyNameOnly.openGaps.includes('external_backend_metadata_missing'));
assert.ok(bevyNameOnly.openGaps.includes('external_profile_class_missing'));

const externalVisual = ledger.rows.find((row) => row.targetId === 'explicit-external-engine-visual');
assert.equal(externalVisual?.matrixOutcome, 'visual_profile_accepted');
assert.equal(externalVisual.backend, 'webgl');
assert.equal(externalVisual.visual.accepted, true);
assert.equal(externalVisual.externalProjectContract.accepted, true);
assert.equal(externalVisual.externalProjectContract.profileClass, 'external_engine_visual_profile');
assert.equal(externalVisual.externalProfileSelection.accepted, true);
assert.equal(externalVisual.externalSourceDelta.accepted, true);
assert.equal(externalVisual.externalSourceDelta.matchCount, 1);
assert.equal(externalVisual.externalVisualProofArtifact.accepted, true);
assert.equal(externalVisual.externalVisualProofArtifact.requiredContentHashes.length, 3);
assert.equal(externalVisual.externalVisualProofArtifact.visualDiff.accepted, true);

const forgedExternalVisual = ledger.rows.find((row) => row.targetId === 'forged-external-engine-visual');
assert.equal(forgedExternalVisual?.matrixOutcome, 'unproven');
assert.equal(forgedExternalVisual.backend, 'webgl');
assert.equal(forgedExternalVisual.visual.accepted, true);
assert.equal(forgedExternalVisual.externalProjectContract.accepted, true);
assert.equal(forgedExternalVisual.externalProfileSelection.accepted, false);
assert.equal(forgedExternalVisual.externalSourceDelta.accepted, false);
assert.equal(forgedExternalVisual.externalVisualProofArtifact.accepted, false);
assert.ok(forgedExternalVisual.openGaps.includes('external_profile_selection_schema_missing'));
assert.ok(forgedExternalVisual.openGaps.includes('external_source_delta_schema_missing'));
assert.ok(forgedExternalVisual.openGaps.includes('external_visual_proof_artifact_path_missing'));

const largeRocm = ledger.rows.find((row) =>
  row.proofMode === 'real_rocm_repo_validation'
  && row.targetId === 'real-rocm-large-lib'
);
assert.equal(largeRocm?.targetId, 'real-rocm-large-lib');
assert.equal(largeRocm.backend, 'hip');
assert.equal(largeRocm.matrixOutcome, 'refusal_proven');
assert.equal(largeRocm.acceptedForGpuHmr, false);
assert.equal(largeRocm.gpuHmrSuccess, false);
assert.equal(largeRocm.refusalProven, true);
assert.equal(largeRocm.runtimeProofArtifact.present, false);
assert.equal(largeRocm.realRocmRuntimeCapabilityPreflight.present, true);
assert.equal(largeRocm.realRocmRuntimeCapabilityPreflight.accepted, false);
assert.equal(largeRocm.realRocmRuntimeCapabilityPreflight.deviceCount, 0);
assert.equal(largeRocm.realRocmRuntimeCapabilityPreflight.status, 'gpu-runtime-array-allocation-unavailable');
assert.ok(largeRocm.realRocmRuntimeCapabilityPreflight.blockingGaps.includes('runtime_device_unavailable'));
assert.ok(largeRocm.realRocmRuntimeCapabilityPreflight.blockingGaps.includes('runtime_device_count_zero'));
assert.ok(largeRocm.realRocmRuntimeCapabilityPreflight.blockingGaps.includes(
  'runtime_array_allocation_unavailable',
));
assert.equal(largeRocm.outputOracleResolution.disabledReason, 'profile_disabled');
assert.equal(largeRocm.outputOracleResolution.sourceDerivedCandidateCount, 0);
assert.equal(largeRocm.outputOracleResolution.contractPresent, false);
assert.equal(largeRocm.targetProgression.required, true);
assert.equal(largeRocm.targetProgression.reason, 'phase_not_declared');
assert.equal(largeRocm.targetProgressionGates[0]?.status, 'fail');
assert.equal(largeRocm.realRocmProfileProofObligations.status, 'profile_proof_obligations_unmet');
assert.ok(largeRocm.realRocmProfileProofObligations.blockingGaps.includes(
  'proof_obligation_output_oracle_profile_missing',
));
assert.equal(largeRocm.realRocmAppHookContract.status, 'required_app_hook_contract_missing');
assert.equal(largeRocm.realRocmAppHookContract.canSatisfyRuntimeProof, false);
assert.equal(largeRocm.realRocmDeviceSidecarContract.status, 'derived_device_sidecar_candidate_not_runtime_proof');
assert.equal(largeRocm.realRocmDeviceSidecarContract.canSatisfyRuntimeProof, false);
assert.equal(largeRocm.realRocmSidecarRuntimeConsistency.status, 'sidecar_runtime_backend_consistent_not_runtime_proof');
assert.equal(largeRocm.realRocmSidecarRuntimeConsistency.backendConsistent, true);
assert.ok(largeRocm.reasons.includes('runtime_proof_artifact_missing'));
assert.ok(largeRocm.reasons.includes('proof_state_missing'));
assert.ok(largeRocm.reasons.includes('output_or_visual_oracle_proof_missing'));
assert.ok(largeRocm.reasons.includes('target_progression_gate_failed:target progression phase'));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_output_oracle_profile_missing',
));
assert.ok(largeRocm.reasons.includes('real_rocm_app_hook_contract:app_hook_contract_not_declared'));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_device_sidecar_contract:derived_device_sidecar_candidate_not_runtime_proof',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_sidecar_runtime_consistency:sidecar_runtime_sidecar_observation_missing',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_runtime_capability_preflight:gpu-runtime-array-allocation-unavailable',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_runtime_capability_preflight:runtime_device_unavailable',
));
assert.ok(largeRocm.openGaps.includes('output_or_visual_oracle_proof_required'));
assert.ok(largeRocm.openGaps.includes('target_progression_gates_failed'));
assert.ok(largeRocm.openGaps.includes('real_rocm_runtime_capability_preflight_failed'));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_runtime_capability_preflight:runtime_device_unavailable',
));
assert.ok(largeRocm.openGaps.includes('real_rocm_profile_proof_obligations_required'));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_output_oracle_profile_missing',
));
assert.equal(largeRocm.cpuHmrUsed, null);
assert.equal(largeRocm.fullRebuildUsed, null);
assert.equal(largeRocm.processRestarted, null);
assert.equal(largeRocm.realRocmFirewall.accepted, false);
assert.ok(largeRocm.openGaps.includes('real_rocm_cpu_gpu_firewall_required'));
assert.ok(largeRocm.openGaps.includes('real_rocm_cpu_gpu_firewall:cpu_hmr_absence_evidence_required'));
assert.ok(largeRocm.openGaps.includes('real_rocm_cpu_gpu_firewall:full_rebuild_absence_evidence_required'));
assert.ok(largeRocm.openGaps.includes('real_rocm_cpu_gpu_firewall:process_restart_absence_evidence_required'));
assert.ok(largeRocm.openGaps.includes('real_rocm_app_hook_contract:app_hook_artifact_transport_evidence_missing'));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_device_sidecar_contract:device_sidecar_dispatch_trace_runtime_not_observed',
));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_sidecar_runtime_consistency:sidecar_runtime_sidecar_observation_missing',
));

const originalHostPreflightRocm = ledger.rows.find((row) =>
  row.proofMode === 'real_rocm_repo_validation'
  && row.targetId === 'real-rocm-original-host-preflight'
);
assert.equal(originalHostPreflightRocm?.matrixOutcome, 'unproven');
assert.equal(originalHostPreflightRocm.acceptedForGpuHmr, false);
assert.equal(originalHostPreflightRocm.realRocmRuntimeCapabilityPreflight.present, true);
assert.equal(originalHostPreflightRocm.realRocmRuntimeCapabilityPreflight.accepted, false);
assert.equal(originalHostPreflightRocm.realRocmRuntimeCapabilityPreflight.allocationAvailable, false);
assert.ok(originalHostPreflightRocm.realRocmRuntimeCapabilityPreflight.blockingGaps.includes(
  'runtime_device_unavailable',
));
assert.ok(originalHostPreflightRocm.openGaps.includes('real_rocm_runtime_capability_preflight_failed'));
assert.ok(originalHostPreflightRocm.reasons.includes(
  'real_rocm_runtime_capability_preflight:gpu-runtime-array-allocation-unavailable',
));

const requiredProgressionRocmDir = path.join(logsRoot, 'real-rocm-required-progression-runtime');
await writeJson(path.join(requiredProgressionRocmDir, 'real-rocm-required-progression-runtime.json'), {
  slug: 'gpu-real-rocm-required-progression-runtime-20260623',
  real_rocm_profile: { id: 'real-rocm-required-progression-runtime' },
  source_url: 'https://example.invalid/rocm/required-progression.git',
  repo_commit: '0123456789abcdef0123456789abcdef01234567',
  entry_file: 'src/kernels/required_progression.hip',
  delta_file: 'src/kernels/required_progression.hip',
  target_name: 'RequiredProgressionDriver',
  gpu_vendor: 'rocm',
  full_runtime_proven: false,
  gpu_hmr_success: false,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'none',
    mode: 'none',
    disabledReason: 'profile_disabled',
    contractPresent: false,
    runtimeProfilePresent: false,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  strict_proof_gates: {
    schemaVersion: 'synthi.gpu_hmr.strict_proof_gates.v1',
    status: 'fail',
    accepted: false,
    failures: ['runtime_proof_artifact_missing'],
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/required-progression.git @ 0123456789ab files=2000' },
    {
      name: 'real_repo_user_source_delta_hmr',
      status: 'warn',
      detail: JSON.stringify({
        wait_hmr_status: 'timeout',
        gpu_proof_validation: { reason: 'proof_state_missing', satisfied: false },
      }),
    },
  ],
});
const requiredProgressionLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [requiredProgressionRocmDir],
  generatedAt: '2026-06-09T00:00:01.100Z',
  includeUnproven: true,
});
const requiredProgressionRow = requiredProgressionLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(requiredProgressionRow?.matrixOutcome, 'refusal_proven');
assert.equal(requiredProgressionRow.acceptedForGpuHmr, false);
assert.equal(requiredProgressionRow.refusalProven, true);
assert.ok(requiredProgressionRow.openGaps.includes('strict_runtime_proof_artifact_required'));

const truncatedVisual = ledger.rows.find((row) => row.targetId === 'truncated-visual');
assert.equal(truncatedVisual?.matrixOutcome, 'unproven');
assert.equal(truncatedVisual.acceptedForGpuHmr, false);
assert.equal(truncatedVisual.visual.present, true);
assert.equal(truncatedVisual.visual.allImagesArePng, true);
assert.equal(truncatedVisual.visual.allImagesDecode, false);
assert.equal(truncatedVisual.visual.decodedImageCount, 0);
assert.ok(truncatedVisual.visual.images.every((image) => image.decodeError?.startsWith('png_decode_failed')));
assert.ok(truncatedVisual.reasons.includes('visual_artifacts_not_readable'));

const noVisualOptOut = ledger.rows.find((row) => row.targetId === 'no-visual-optout');
assert.equal(noVisualOptOut?.matrixOutcome, 'unproven');
assert.equal(noVisualOptOut.acceptedForGpuHmr, false);
assert.equal(noVisualOptOut.visual.required, true);
assert.equal(noVisualOptOut.visual.present, false);
assert.equal(noVisualOptOut.visual.accepted, false);
assert.ok(noVisualOptOut.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpu = ledger.rows.find((row) => row.targetId === 'forged-webgpu');
assert.equal(forgedWebGpu?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpu.acceptedForGpuHmr, false);
assert.ok(forgedWebGpu.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpuQueryOnly = ledger.rows.find((row) => row.targetId === 'forged-webgpu-query-only');
assert.equal(forgedWebGpuQueryOnly?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuQueryOnly.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuQueryOnly.visual.accepted, true);
assert.equal(forgedWebGpuQueryOnly.visual.allImagesAreDecodedPng, true);
assert.equal(forgedWebGpuQueryOnly.ledger.present, false);
assert.equal(forgedWebGpuQueryOnly.ledger.source, 'supplied_query_ignored_no_ledger');
assert.ok(forgedWebGpuQueryOnly.reasons.includes('proof_ledger_record_missing'));

const forgedSourceAdaptedWebGpu = ledger.rows.find((row) =>
  row.targetId === 'forged-source-adapted-webgpu'
);
assert.equal(forgedSourceAdaptedWebGpu?.matrixOutcome, 'visual_profile_accepted');
assert.equal(forgedSourceAdaptedWebGpu.acceptedForGpuHmr, false);
assert.equal(forgedSourceAdaptedWebGpu.gpuHmrSuccess, false);
assert.equal(forgedSourceAdaptedWebGpu.visualProfileAccepted, true);
assert.equal(forgedSourceAdaptedWebGpu.sourceAdaptedProfile, true);
assert.equal(forgedSourceAdaptedWebGpu.runtimeProofArtifact.accepted, true);
assert.equal(forgedSourceAdaptedWebGpu.ledger.gpuHmrSuccess, true);
assert.equal(forgedSourceAdaptedWebGpu.backend, 'webgpu');
assert.ok(forgedSourceAdaptedWebGpu.reasons.includes('source_adapted_profile_not_no_shim_gpu_hmr'));
assert.ok(forgedSourceAdaptedWebGpu.openGaps.includes('source_adapted_profile_not_no_shim_gpu_hmr'));

const forgedTopLevelSourceAdaptedWebGpu = ledger.rows.find((row) =>
  row.targetId === 'forged-top-level-source-adapted-webgpu'
);
assert.equal(forgedTopLevelSourceAdaptedWebGpu?.matrixOutcome, 'visual_profile_accepted');
assert.equal(forgedTopLevelSourceAdaptedWebGpu.acceptedForGpuHmr, false);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.gpuHmrSuccess, false);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.visualProfileAccepted, true);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.sourceAdaptedProfile, true);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.sourceAdaptation.sourceAdaptedProfile, true);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.runtimeProbeInstrumentation.accepted, false);
assert.equal(forgedTopLevelSourceAdaptedWebGpu.backend, 'webgpu');
assert.ok(forgedTopLevelSourceAdaptedWebGpu.reasons.includes('source_adapted_profile_not_no_shim_gpu_hmr'));
assert.ok(forgedTopLevelSourceAdaptedWebGpu.openGaps.includes('source_adapted_profile_not_no_shim_gpu_hmr'));

const forgedSourceAdaptedWebGpuVisual = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-source-adapted-visual'
);
assert.equal(forgedSourceAdaptedWebGpuVisual?.proofMode, 'webgpu_wgsl_runtime_visual');
assert.equal(forgedSourceAdaptedWebGpuVisual.matrixOutcome, 'visual_profile_accepted');
assert.equal(forgedSourceAdaptedWebGpuVisual.acceptedForGpuHmr, false);
assert.equal(forgedSourceAdaptedWebGpuVisual.gpuHmrSuccess, false);
assert.equal(forgedSourceAdaptedWebGpuVisual.visualProfileAccepted, true);
assert.equal(forgedSourceAdaptedWebGpuVisual.sourceAdaptedProfile, true);
assert.equal(forgedSourceAdaptedWebGpuVisual.ledger.gpuHmrSuccess, true);
assert.equal(forgedSourceAdaptedWebGpuVisual.visual.accepted, true);
assert.equal(forgedSourceAdaptedWebGpuVisual.declaredScopeEvidence.accepted, true);
assert.ok(forgedSourceAdaptedWebGpuVisual.reasons.includes(
  'source_adapted_profile_not_no_shim_gpu_hmr',
));
assert.ok(forgedSourceAdaptedWebGpuVisual.openGaps.includes(
  'source_adapted_profile_not_no_shim_gpu_hmr',
));

const forgedWebGpuCompute = ledger.rows.find((row) => row.targetId === 'forged-webgpu-compute');
assert.equal(forgedWebGpuCompute?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuCompute.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuCompute.outputOracleFacet.accepted, false);
assert.equal(forgedWebGpuCompute.visual.accepted, false);
assert.equal(
  forgedWebGpuCompute.visual.reason,
  'webgpu_compute_readback_uses_compute_card_not_runtime_frame_visual_proof',
);
assert.ok(forgedWebGpuCompute.reasons.includes('proof_ledger_record_missing'));
assert.ok(forgedWebGpuCompute.reasons.includes('compute_oracle_files_not_accepted'));
assert.ok(forgedWebGpuCompute.reasons.includes('compute_oracle_expected_output_not_verified'));
assert.ok(forgedWebGpuCompute.reasons.includes('webgpu_compute_declared_scope_not_evidence_backed'));

const acceptedHiprt = ledger.rows.find((row) =>
  row.targetId === 'accepted-hiprt-recomputed-oracle'
  && row.proofMode === 'same-process'
);
assert.equal(acceptedHiprt?.matrixOutcome, 'visual_profile_accepted');
assert.equal(acceptedHiprt.acceptedForGpuHmr, false);
assert.equal(acceptedHiprt.visualProfileAccepted, true);
assert.equal(acceptedHiprt.sourceAdaptedProfile, true);
assert.equal(acceptedHiprt.gpuHmrSuccess, false);
assert.equal(acceptedHiprt.oracleRegion.source, 'matrix_recomputed_png_pixels');
assert.equal(acceptedHiprt.oracleRegion.accepted, true);
assert.equal(acceptedHiprt.oracleRegion.nonBlankAfterEpoch, true);
assert.equal(acceptedHiprt.runtimeProbeInstrumentation.accepted, true);
assert.equal(acceptedHiprt.runtimeProbeInstrumentation.scope, 'hiprt_declared_visual_profile');
assert.equal(acceptedHiprt.runtimeProbeInstrumentation.arbitraryLibraryAccepted, false);
assert.ok(acceptedHiprt.reasons.includes('source_adapted_profile_not_no_shim_gpu_hmr'));
assert.ok(acceptedHiprt.openGaps.includes('source_adapted_profile_not_no_shim_gpu_hmr'));

const forgedHiprtMissingInstrumentation = ledger.rows.find(
  (row) => row.targetId === 'forged-hiprt-missing-instrumentation',
);
assert.equal(forgedHiprtMissingInstrumentation?.matrixOutcome, 'unproven');
assert.equal(forgedHiprtMissingInstrumentation.acceptedForGpuHmr, false);
assert.equal(forgedHiprtMissingInstrumentation.runtimeProofArtifact.accepted, true);
assert.equal(forgedHiprtMissingInstrumentation.ledger.gpuHmrSuccess, true);
assert.equal(forgedHiprtMissingInstrumentation.visual.accepted, true);
assert.equal(forgedHiprtMissingInstrumentation.runtimeProbeInstrumentation.accepted, false);
assert.ok(forgedHiprtMissingInstrumentation.reasons.includes(
  'hiprt_profile_instrumentation_disclosure_not_proven',
));
assert.ok(forgedHiprtMissingInstrumentation.openGaps.includes(
  'hiprt_profile_instrumentation_disclosure_required',
));

const forgedHiprt = ledger.rows.find((row) => row.targetId === 'forged-hiprt-oracle-region-json');
assert.equal(forgedHiprt?.matrixOutcome, 'unproven');
assert.equal(forgedHiprt.acceptedForGpuHmr, false);
assert.equal(forgedHiprt.oracleRegion.source, 'matrix_recomputed_png_pixels');
assert.equal(forgedHiprt.oracleRegion.accepted, false);
assert.equal(forgedHiprt.oracleRegion.nonBlankAfterEpoch, false);
assert.ok(forgedHiprt.reasons.includes('hiprt_oracle_region_pixel_recompute_not_accepted'));

const legacyAgentSplit = ledger.rows.find((row) =>
  row.proofMode === 'mcp_preview_visual'
  && row.targetId === 'unknown'
);
assert.equal(legacyAgentSplit?.matrixOutcome, 'unproven');
assert.equal(legacyAgentSplit.targetId, 'unknown');

const forgedLegacyPreview = ledger.rows.find((row) => row.targetId === 'forged-legacy-preview');
assert.equal(forgedLegacyPreview?.proofMode, 'mcp_preview_visual');
assert.equal(forgedLegacyPreview.matrixOutcome, 'unproven');
assert.equal(forgedLegacyPreview.acceptedForGpuHmr, false);
assert.equal(forgedLegacyPreview.ledger.source, 'embedded_validation_claim');
assert.equal(forgedLegacyPreview.runtimeProofArtifact.present, false);
assert.ok(forgedLegacyPreview.reasons.includes('mcp_preview_recomputed_proof_ledger_missing'));
assert.ok(forgedLegacyPreview.reasons.includes('mcp_preview_runtime_proof_artifact_missing'));

assert.equal(ledger.summary.acceptedFullRuntimeGpuHmrRows, 2);
assert.equal(ledger.summary.broadFullRuntimeGpuHmrRows, 0);
assert.equal(ledger.summary.scopedFullRuntimeGpuHmrRows, 2);
assert.equal(ledger.summary.allFullRuntimeGpuHmrRows, 2);
assert.ok(ledger.summary.visualProfileAcceptedRows >= 1);
assert.equal(
  Object.values(ledger.summary.fullRuntimeScopeBreakdown).reduce((sum, count) => sum + count, 0),
  ledger.summary.allFullRuntimeGpuHmrRows,
);
assert.equal(ledger.summary.refusalProvenRows, 5);
assert.ok(ledger.summary.unprovenRows >= 1);

const coverageById = new Map(ledger.summary.planCoverage.map((entry) => [entry.id, entry]));
const flowVisualCoverage = coverageById.get('flow_visual_gpu_path');
assert.equal(flowVisualCoverage?.status, 'accepted');
assert.ok(flowVisualCoverage.rows.some((row) =>
  row.validationProfileEvidence?.accepted === true
  && row.validationProfileEvidence.profileId === 'flow'
  && row.validationProfileEvidence.profileClass === 'flow_visual_gpu_path'
));
assert.equal(coverageById.get('opencl_dispatch_readback')?.status, 'refused');
assert.equal(coverageById.get('bevy_file_loaded_wgsl')?.status, 'refused');
assert.equal(coverageById.get('large_real_rocm_repo')?.status, 'refused');
assert.ok(coverageById.get('large_real_rocm_repo')?.openGaps.includes('output_or_visual_oracle_proof_required'));
assert.equal(coverageById.get('webgpu_scoped_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('webgpu_empty_layout_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('webgpu_profiled_layout_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('webgpu_compute_runtime_readback')?.status, 'missing');
assert.equal(coverageById.get('external_engine_visual_profile')?.status, 'visual_profile_only');
assert.ok(coverageById.get('external_engine_visual_profile')?.rows.every((row) =>
  row.externalProfileSelection?.accepted === true
  && row.externalSourceDelta?.accepted === true
  && row.externalVisualProofArtifact?.accepted === true
));
assert.ok(!coverageById.get('external_engine_visual_profile')?.rows.some((row) =>
  row.targetId === 'forged-external-engine-visual'
));
assert.equal(coverageById.get('per_kernel_smallest_safe_fission')?.status, 'accepted');
assert.equal(coverageById.get('per_target_run_modes')?.status, 'accepted');
assert.ok(coverageById.get('per_target_run_modes')?.acceptedTargetCount > 0);
assert.equal(coverageById.get('per_target_run_modes')?.incompleteTargetCount, 0);
const flowRunModeTarget = coverageById.get('per_target_run_modes')?.targetCoverage.find(
  (entry) => entry.targetKey === 'hip:flow',
);
assert.equal(flowRunModeTarget?.status, 'accepted');
assert.deepEqual(flowRunModeTarget.openGaps, []);
assert.ok(flowRunModeTarget.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:cold')
  && row.runModeCoverageSupport?.accepted === true
));
assert.ok(!flowRunModeTarget.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:forged-unlinked-flow-cold')
));
assert.ok(coverageById.get('per_target_run_modes')?.unlinkedSupportRowCount >= 1);
const optedOutHiprtRunModeTarget = coverageById.get('per_target_run_modes')?.targetCoverage.find(
  (entry) => entry.targetKey === 'hiprt:accepted-hiprt-recomputed-oracle',
);
assert.equal(optedOutHiprtRunModeTarget, undefined);
assert.equal(coverageById.get('hiprt_run_modes')?.status, 'missing');
const hiprtRunModeTarget = coverageById.get('hiprt_run_modes')?.targetCoverage?.find(
  (entry) => entry.targetKey === 'hiprt:accepted-hiprt-recomputed-oracle',
);
assert.equal(hiprtRunModeTarget, undefined);
assert.ok(coverageById.get('hiprt_run_modes')?.openGaps.includes('hiprt_run_mode_proof_required'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:cold_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:hot_delta_1_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:hot_delta_2_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:hot_delta_2_different_edit_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('negative_edit_refusal_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:stale-cold-only:hot_delta_1_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:stale-cold-only:hot_delta_2_evidence_missing'));

const coldRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow' && row.proofMode === 'run_mode_proof' && row.runMode.metricScope === 'cold'
);
assert.equal(coldRunMode?.matrixOutcome, 'cold_split_proven');
assert.equal(coldRunMode.acceptedForGpuHmr, false);
assert.equal(coldRunMode.artifactSchema, 'synthi.gpu.hmr.runtime_run_mode_proof.v1');
assert.equal(coldRunMode.proofChain, 'runtime_initial_visual_gate');

const hot2RunMode = ledger.rows.find((row) =>
  row.targetId === 'flow' && row.proofMode === 'run_mode_proof' && row.runMode.metricScope === 'hot_delta_2'
);
assert.equal(hot2RunMode?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(hot2RunMode.artifactSchema, 'synthi.gpu.hmr.runtime_run_mode_proof.v1');
assert.equal(hot2RunMode.runMode.differentEdit, true);

const negativeEdit = ledger.rows.find((row) => row.proofMode === 'negative_edit');
assert.equal(negativeEdit?.matrixOutcome, 'refusal_proven');
assert.equal(negativeEdit.runModeCoverageSupport.accepted, true);

const forgedUnlinkedFlowCold = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:forged-unlinked-flow-cold')
);
assert.equal(forgedUnlinkedFlowCold?.matrixOutcome, 'cold_split_proven');
assert.equal(forgedUnlinkedFlowCold.runModeCoverageSupport.accepted, false);
assert.ok(forgedUnlinkedFlowCold.runModeCoverageSupport.failedGates.includes(
  'run_mode_support_parent_proof_id_missing',
));

const spoofNamedFlowDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow-name-only-profile');
await writeRgbaPng(path.join(spoofNamedFlowDir, 'before.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(spoofNamedFlowDir, 'after.png'), 8, 8, (x, y) => [80 + x, 92 + y, 120, 255]);
await writeRgbaPng(path.join(spoofNamedFlowDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(spoofNamedFlowDir, 'hot1-name-only.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:flow-name-only-hot1', 'gpu-runtime-proof:sha256:flow-name-only-hot1'),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'flow',
    visualRoot: spoofNamedFlowDir,
  }),
  proofId: 'agent-split-run-mode-proof:sha256:flow-name-only-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(spoofNamedFlowDir, 'before.png'),
    afterImage: path.join(spoofNamedFlowDir, 'after.png'),
    diffImage: path.join(spoofNamedFlowDir, 'diff.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-name-only-hot1',
    editHash: 'sha256:flow-name-only-hot1',
    editKind: 'gpu_artifact_edit',
  },
});
const spoofNamedFlowLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [spoofNamedFlowDir],
  generatedAt: '2026-06-09T00:00:01.010Z',
  includeUnproven: true,
});
const spoofNamedFlowCoverage = new Map(spoofNamedFlowLedger.summary.planCoverage.map((entry) => [entry.id, entry]));
const spoofNamedFlowRuntime = spoofNamedFlowLedger.rows.find((row) => row.targetId === 'flow');
assert.equal(spoofNamedFlowRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(spoofNamedFlowRuntime.validationProfileEvidence.accepted, false);
assert.equal(spoofNamedFlowCoverage.get('flow_visual_gpu_path')?.status, 'missing');
assert.ok(spoofNamedFlowCoverage.get('flow_visual_gpu_path')?.openGaps.includes(
  'flow_visual_runtime_profile_evidence_required',
));

const forgedAcceptedProfileDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-non-flow-forged-profile');
await writeRgbaPng(path.join(forgedAcceptedProfileDir, 'before.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(forgedAcceptedProfileDir, 'after.png'), 8, 8, (x, y) => [88 + x, 96 + y, 132, 255]);
await writeRgbaPng(path.join(forgedAcceptedProfileDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const forgedAcceptedProfileMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'not-flow-runtime-target',
  visualRoot: forgedAcceptedProfileDir,
});
await writeJson(path.join(forgedAcceptedProfileDir, 'hot1-forged-flow-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    forgedAcceptedProfileMaterials.proofLedgerQuery.record.proofId,
    forgedAcceptedProfileMaterials.runtimeProofArtifact.proofId,
  ),
  ...forgedAcceptedProfileMaterials,
  targetId: 'not-flow-runtime-target',
  profileId: 'not-flow-runtime-target',
  proofId: 'agent-split-run-mode-proof:sha256:not-flow-forged-flow-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    evidenceRefs: [
      'evidence:validation-profile:flow:runtime-visual',
      forgedAcceptedProfileMaterials.proofLedgerQuery.record.proofId,
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:not-flow-forged-flow-profile',
      forgedAcceptedProfileMaterials.proofLedgerQuery.record.proofId,
      forgedAcceptedProfileMaterials.runtimeProofArtifact.proofId,
    ],
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(forgedAcceptedProfileDir, 'before.png'),
    afterImage: path.join(forgedAcceptedProfileDir, 'after.png'),
    diffImage: path.join(forgedAcceptedProfileDir, 'diff.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:not-flow-forged-profile',
    editHash: 'sha256:not-flow-forged-profile',
    editKind: 'gpu_artifact_edit',
  },
});
const forgedAcceptedProfileLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedAcceptedProfileDir],
  generatedAt: '2026-06-09T00:00:01.020Z',
  includeUnproven: true,
});
const forgedAcceptedProfileCoverage = new Map(
  forgedAcceptedProfileLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const forgedAcceptedProfileRuntime = forgedAcceptedProfileLedger.rows.find((row) =>
  row.targetId === 'not-flow-runtime-target'
);
assert.equal(forgedAcceptedProfileRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(forgedAcceptedProfileRuntime.validationProfileEvidence.accepted, false);
assert.ok(forgedAcceptedProfileRuntime.validationProfileEvidence.failedGates.includes(
  'validation_profile_id_not_bound_to_runtime_identity',
));
assert.equal(forgedAcceptedProfileCoverage.get('flow_visual_gpu_path')?.status, 'missing');

const duplicateHot2Dir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow-duplicate-hot2');
await writeRgbaPng(path.join(duplicateHot2Dir, 'before.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(duplicateHot2Dir, 'after.png'), 8, 8, (x, y) => [64 + x, 72 + y, 96, 255]);
await writeRgbaPng(path.join(duplicateHot2Dir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(duplicateHot2Dir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:duplicate-hot1', 'gpu-runtime-proof:sha256:duplicate-hot1'),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'duplicate-hot2',
    visualRoot: duplicateHot2Dir,
  }),
  targetId: 'duplicate-hot2',
  profileId: 'duplicate-hot2',
  proofId: 'agent-split-run-mode-proof:sha256:duplicate-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(duplicateHot2Dir, 'before.png'),
    afterImage: path.join(duplicateHot2Dir, 'after.png'),
    diffImage: path.join(duplicateHot2Dir, 'diff.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:duplicate-hot1',
    editHash: 'sha256:same-edit',
  },
});
await writeJson(path.join(duplicateHot2Dir, 'hot2.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:duplicate-hot2', 'gpu-runtime-proof:sha256:duplicate-hot2'),
  ...runtimeProofMaterials('hot_delta_2', {
    projectId: 'duplicate-hot2',
    visualRoot: duplicateHot2Dir,
  }),
  targetId: 'duplicate-hot2',
  profileId: 'duplicate-hot2',
  proofId: 'agent-split-run-mode-proof:sha256:duplicate-hot2',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(duplicateHot2Dir, 'before.png'),
    afterImage: path.join(duplicateHot2Dir, 'after.png'),
    diffImage: path.join(duplicateHot2Dir, 'diff.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:duplicate-hot2',
    editHash: 'sha256:same-edit',
    editKind: 'gpu_artifact_edit',
    differentEdit: false,
  },
});
const duplicateLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [duplicateHot2Dir],
  generatedAt: '2026-06-09T00:00:01.000Z',
  includeUnproven: true,
});
const duplicateCoverage = new Map(duplicateLedger.summary.planCoverage.map((entry) => [entry.id, entry]));
assert.equal(duplicateCoverage.get('per_target_run_modes')?.status, 'missing');
assert.ok(duplicateCoverage.get('per_target_run_modes')?.openGaps.includes(
  'hip:duplicate-hot2:hot_delta_2_different_edit_evidence_missing',
));

const fissionRow = ledger.rows.find((row) => row.matrixOutcome === 'deterministic_fission_proven');
assert.equal(fissionRow?.acceptedForGpuHmr, false);
assert.equal(fissionRow.proofChainAccepted, true);
assert.equal(fissionRow.acceptanceClass, 'smallest_safe_per_kernel_fission');

const acceptedRealRocmDir = path.join(logsRoot, 'real-rocm-accepted-lib');
await writeRgbaPng(path.join(acceptedRealRocmDir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(acceptedRealRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [80 + x, 96 + y, 128, 255]);
await writeRgbaPng(path.join(acceptedRealRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(acceptedRealRocmDir, 'real-rocm-accepted.json'), {
  slug: 'gpu-real-rocm-accepted-lib-20260623',
  real_rocm_profile: { id: 'real-rocm-accepted-lib' },
  source_url: 'https://example.invalid/rocm/accepted-lib.git',
  repo_commit: 'abcdef0123456789abcdef0123456789abcdef01',
  entry_file: 'src/kernels/accepted_entry.hip',
  delta_file: 'src/kernels/accepted_delta.h',
  target_name: 'AcceptedRocmDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
    targetName: 'AcceptedRocmDriver',
    finalAcceptanceTarget: 'AcceptedRocmDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    nonFinalPhase: true,
    nonFinalTargetRequired: true,
    requirements: ['target_must_not_be_final_acceptance_target_when_declared', 'output_oracle_proven'],
  },
  target_progression_gates: [
    {
      name: 'target progression phase',
      status: 'pass',
      detail: 'phase=small-oracle target=AcceptedRocmDriver final_target=AcceptedRocmDriver',
    },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-accepted-lib',
    visualRoot: acceptedRealRocmDir,
  }),
  visual_artifact_paths: [
    path.join(acceptedRealRocmDir, 'before-hmr-first.png'),
    path.join(acceptedRealRocmDir, 'after-hmr-first.png'),
    path.join(acceptedRealRocmDir, 'before-after-diff.png'),
  ],
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-lib-delta',
    editHash: hashValue('real-rocm-accepted-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-lib.git @ abcdef012345 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedRealRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedRealRocmDir],
  generatedAt: '2026-06-09T00:00:02.000Z',
  includeUnproven: true,
});
const acceptedRealRocm = acceptedRealRocmLedger.rows.find((row) => row.proofMode === 'real_rocm_repo_validation');
assert.equal(acceptedRealRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedRealRocm.acceptedForGpuHmr, true);
assert.equal(acceptedRealRocm.ledger.source, 'recomputed_ledger');
assert.equal(acceptedRealRocm.runtimeProofArtifact.accepted, true);
assert.equal(acceptedRealRocm.visual.present, true);
assert.equal(acceptedRealRocm.visual.accepted, true);
assert.equal(acceptedRealRocm.outputOracleResolution.selectedSource, 'profile_runtime_profile');
assert.equal(acceptedRealRocm.outputOracleResolution.contractPresent, true);
assert.equal(acceptedRealRocm.targetProgression.phase, 'small-oracle');
assert.equal(acceptedRealRocm.targetProgressionGates[0]?.status, 'pass');
assert.equal(acceptedRealRocm.coverageObligations.perTargetRunModes, false);
assert.equal(acceptedRealRocm.validationTargetScope, 'evidence_row');
assert.equal(acceptedRealRocm.cpuHmrUsed, false);
assert.equal(acceptedRealRocm.fullRebuildUsed, false);
assert.equal(acceptedRealRocm.processRestarted, false);
assert.equal(acceptedRealRocm.realRocmFirewall.accepted, true);
assert.equal(acceptedRealRocm.realRocmFirewall.firewallEvidenceSource, 'proof_ledger_invariant_summary');
assert.equal(acceptedRealRocm.realRocmRuntimeChain.accepted, true);
assert.equal(acceptedRealRocm.realRocmRuntimeChain.selectedLoaderTransport, 'ram_bytes');
assert.equal(acceptedRealRocm.realRocmRuntimeChain.runtimeSessionId, 'runtime-session:hot_delta_1');
assert.equal(acceptedRealRocm.realRocmRuntimeChain.dispatchTableEntryId, 'dispatch-table-entry:hot_delta_1');
assert.equal(acceptedRealRocm.realRocmRuntimeChain.outputTargetId, 'output-target:hot_delta_1');
assert.equal(acceptedRealRocm.realRocmRuntimeCapabilityPreflight.present, true);
assert.equal(acceptedRealRocm.realRocmRuntimeCapabilityPreflight.accepted, true);
const acceptedRealRocmCoverage = new Map(acceptedRealRocmLedger.summary.planCoverage.map((entry) => [entry.id, entry]));
assert.equal(acceptedRealRocmCoverage.get('large_real_rocm_repo')?.status, 'accepted');
assert.equal(acceptedRealRocmCoverage.get('per_target_run_modes')?.status, 'missing');
assert.equal(acceptedRealRocmCoverage.get('per_target_run_modes')?.targetCoverage.length, 0);

async function writeForgedRealRocmFirewallCase({ slug, field, expectedReason }) {
  const dir = path.join(logsRoot, `real-rocm-forged-${slug}`);
  await writeRgbaPng(path.join(dir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
  await writeRgbaPng(path.join(dir, 'after-hmr-first.png'), 8, 8, (x, y) => [90 + x, 104 + y, 140, 255]);
  await writeRgbaPng(path.join(dir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
  const materials = realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: `real-rocm-forged-${slug}`,
    visualRoot: dir,
  });
  const record = materials.proofLedger.records[0];
  if (field === 'cpu') {
    record.cpuHmrUsed = true;
    record.cpu_hmr_used = true;
  } else if (field === 'full_rebuild') {
    record.fullRebuildUsed = true;
    record.full_rebuild_used = true;
  } else if (field === 'process_restart') {
    record.processRestarted = true;
    record.process_restarted = true;
  }
  await writeJson(path.join(dir, `real-rocm-forged-${slug}.json`), {
    slug: `gpu-real-rocm-forged-${slug}-20260623`,
    real_rocm_profile: { id: `real-rocm-forged-${slug}` },
    source_url: `https://example.invalid/rocm/forged-${slug}.git`,
    repo_commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
    entry_file: 'src/kernels/firewall_entry.hip',
    delta_file: 'src/kernels/firewall_delta.h',
    target_name: `ForgedFirewall${slug}`,
    gpu_vendor: 'rocm',
    full_runtime_proof_required: true,
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_oracle_resolution: {
      schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
      requestedProfile: 'profile.tensor.checksum.v1',
      mode: 'profile.tensor.checksum.v1',
      selectedSource: 'profile_runtime_profile',
      disabledReason: null,
      failedReason: null,
      contractPresent: true,
      runtimeProfilePresent: true,
      runtimeProfileSynced: true,
    },
    target_progression: {
      schemaVersion: 'synthi.real_rocm.target_progression.v1',
      required: false,
      phaseRaw: 'small-oracle',
      phase: 'small-oracle',
      recognized: true,
      reason: null,
    },
    target_progression_gates: [
      { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
    ],
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    ...materials,
    visual_artifact_paths: [
      path.join(dir, 'before-hmr-first.png'),
      path.join(dir, 'after-hmr-first.png'),
      path.join(dir, 'before-after-diff.png'),
    ],
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: `real-rocm-forged-${slug}-delta`,
      editHash: hashValue(`real-rocm-forged-${slug}-delta`),
    },
    checks: [
      { name: 'real ROCm repo', status: 'pass', detail: `https://example.invalid/rocm/forged-${slug}.git @ abcdef files=12000` },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  });
  const forgedLedger = await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [dir],
    generatedAt: '2026-06-09T00:00:02.020Z',
    includeUnproven: true,
  });
  const row = forgedLedger.rows.find((entry) => entry.proofMode === 'real_rocm_repo_validation');
  assert.equal(row?.matrixOutcome, 'unproven');
  assert.equal(row.acceptedForGpuHmr, false);
  assert.equal(row.realRocmFirewall.accepted, false);
  assert.ok(row.reasons.includes(expectedReason));
  assert.ok(row.reasons.includes('real_rocm_cpu_gpu_firewall_not_proven'));
  assert.ok(row.openGaps.includes('real_rocm_cpu_gpu_firewall_required'));
  assert.ok(row.openGaps.includes(`real_rocm_cpu_gpu_firewall:${expectedReason}`));
  return row;
}

const forgedCpuFirewall = await writeForgedRealRocmFirewallCase({
  slug: 'cpu-hmr-firewall',
  field: 'cpu',
  expectedReason: 'cpu_hmr_used_by_real_rocm_firewall',
});
assert.equal(forgedCpuFirewall.cpuHmrUsed, true);
const forgedFullRebuildFirewall = await writeForgedRealRocmFirewallCase({
  slug: 'full-rebuild-firewall',
  field: 'full_rebuild',
  expectedReason: 'full_rebuild_used_by_real_rocm_firewall',
});
assert.equal(forgedFullRebuildFirewall.fullRebuildUsed, true);
const forgedRestartFirewall = await writeForgedRealRocmFirewallCase({
  slug: 'process-restart-firewall',
  field: 'process_restart',
  expectedReason: 'process_restart_observed_by_real_rocm_firewall',
});
assert.equal(forgedRestartFirewall.processRestarted, true);

const forgedOldArtifactRocmDir = path.join(logsRoot, 'real-rocm-forged-old-artifact-dispatch');
await writeRgbaPng(path.join(forgedOldArtifactRocmDir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(forgedOldArtifactRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [94 + x, 106 + y, 144, 255]);
await writeRgbaPng(path.join(forgedOldArtifactRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
const forgedOldArtifactMaterials = realRocmRuntimeProofMaterials('hot_delta_1', {
  projectId: 'real-rocm-forged-old-artifact-dispatch',
  visualRoot: forgedOldArtifactRocmDir,
});
forgedOldArtifactMaterials.proofLedger.records[0].dispatchEvent.artifact_hash =
  hashValue('old-artifact-dispatched');
await writeJson(path.join(forgedOldArtifactRocmDir, 'real-rocm-forged-old-artifact-dispatch.json'), {
  slug: 'gpu-real-rocm-forged-old-artifact-dispatch-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-old-artifact-dispatch' },
  source_url: 'https://example.invalid/rocm/forged-old-artifact.git',
  repo_commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  entry_file: 'src/kernels/old_artifact_entry.hip',
  delta_file: 'src/kernels/old_artifact_delta.h',
  target_name: 'ForgedOldArtifactDispatch',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedOldArtifactMaterials,
  visual_artifact_paths: [
    path.join(forgedOldArtifactRocmDir, 'before-hmr-first.png'),
    path.join(forgedOldArtifactRocmDir, 'after-hmr-first.png'),
    path.join(forgedOldArtifactRocmDir, 'before-after-diff.png'),
  ],
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-old-artifact-dispatch-delta',
    editHash: hashValue('real-rocm-forged-old-artifact-dispatch-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-old-artifact.git @ abcdef files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedOldArtifactLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedOldArtifactRocmDir],
  generatedAt: '2026-06-09T00:00:02.025Z',
  includeUnproven: true,
});
const forgedOldArtifact = forgedOldArtifactLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedOldArtifact?.matrixOutcome, 'unproven');
assert.equal(forgedOldArtifact.acceptedForGpuHmr, false);
assert.equal(forgedOldArtifact.ledger.gpuHmrSuccess, false);
assert.ok(forgedOldArtifact.reasons.includes('dispatch_artifact_hash_mismatch'));
assert.ok(forgedOldArtifact.openGaps.includes('proof_ledger_success_required'));

const forgedSidecarMismatchRocmDir = path.join(logsRoot, 'real-rocm-forged-sidecar-mismatch');
await writeRgbaPng(path.join(forgedSidecarMismatchRocmDir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(forgedSidecarMismatchRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [88 + x, 100 + y, 136, 255]);
await writeRgbaPng(path.join(forgedSidecarMismatchRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedSidecarMismatchRocmDir, 'real-rocm-forged-sidecar-mismatch.json'), {
  slug: 'gpu-real-rocm-forged-sidecar-mismatch-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-sidecar-mismatch' },
  source_url: 'https://example.invalid/rocm/forged-sidecar-mismatch.git',
  repo_commit: 'bcdef0123456789abcdef0123456789abcdef012',
  entry_file: 'src/kernels/sidecar_entry.cl',
  delta_file: 'src/kernels/sidecar_delta.h',
  target_name: 'ForgedSidecarMismatchDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  real_rocm_device_sidecar_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract_facet.v1',
    declared: true,
    required: true,
    status: 'declared_device_sidecar_contract_not_runtime_proof',
    proofAuthority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    proof_authority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    backend: 'opencl',
    artifact_identity: {
      source_paths: ['src/kernels/sidecar_entry.cl'],
      artifact_kind: 'opencl_program',
      entry_points: ['opencl_sidecar_kernel'],
      compile_target: 'gfx1201',
      compiler: '/opt/rocm/llvm/bin/amdclang',
      compiler_args_hash: hashValue('forged-sidecar-mismatch-compile-args'),
    },
    blockingGaps: ['device_sidecar_dispatch_trace_runtime_not_observed'],
    blocking_gaps: ['device_sidecar_dispatch_trace_runtime_not_observed'],
  },
  real_rocm_sidecar_runtime_consistency: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1',
    status: 'sidecar_runtime_backend_inconsistent_or_unproven',
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sidecarBackend: 'opencl',
    sidecar_backend: 'opencl',
    runtimeBackendCandidates: ['hip'],
    runtime_backend_candidates: ['hip'],
    backendConsistent: false,
    backend_consistent: false,
    blockingGaps: ['sidecar_runtime_backend_mismatch'],
    blocking_gaps: ['sidecar_runtime_backend_mismatch'],
  },
  real_rocm_runtime_eligibility: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_eligibility.v1',
    status: 'supplemental_runtime_proof_evidence',
    backendCandidates: ['hip'],
    backend_candidates: ['hip'],
    blockingGaps: [],
    blocking_gaps: [],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-forged-sidecar-mismatch',
    visualRoot: forgedSidecarMismatchRocmDir,
  }),
  visual_artifact_paths: [
    path.join(forgedSidecarMismatchRocmDir, 'before-hmr-first.png'),
    path.join(forgedSidecarMismatchRocmDir, 'after-hmr-first.png'),
    path.join(forgedSidecarMismatchRocmDir, 'before-after-diff.png'),
  ],
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-sidecar-mismatch-delta',
    editHash: hashValue('real-rocm-forged-sidecar-mismatch-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-sidecar-mismatch.git @ bcdef012345 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedSidecarMismatchLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedSidecarMismatchRocmDir],
  generatedAt: '2026-06-09T00:00:02.050Z',
  includeUnproven: true,
});
const forgedSidecarMismatch = forgedSidecarMismatchLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedSidecarMismatch?.matrixOutcome, 'unproven');
assert.equal(forgedSidecarMismatch.acceptedForGpuHmr, false);
assert.equal(forgedSidecarMismatch.runtimeProofArtifact.accepted, true);
assert.equal(forgedSidecarMismatch.ledger.gpuHmrSuccess, true);
assert.equal(forgedSidecarMismatch.outputOracleFacet.accepted, true);
assert.equal(forgedSidecarMismatch.realRocmSidecarRuntimeConsistency.backendConsistent, false);
assert.ok(forgedSidecarMismatch.reasons.includes('real_rocm_sidecar_runtime_consistency_not_proven'));
assert.ok(forgedSidecarMismatch.reasons.includes(
  'real_rocm_sidecar_runtime_consistency:sidecar_runtime_backend_mismatch',
));
assert.ok(forgedSidecarMismatch.openGaps.includes('real_rocm_sidecar_runtime_consistency_required'));
assert.ok(forgedSidecarMismatch.openGaps.includes(
  'real_rocm_sidecar_runtime_consistency:sidecar_runtime_backend_mismatch',
));

const forgedRequiredHookRocmDir = path.join(logsRoot, 'real-rocm-forged-required-hook');
await writeRgbaPng(path.join(forgedRequiredHookRocmDir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(forgedRequiredHookRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [90 + x, 112 + y, 140, 255]);
await writeRgbaPng(path.join(forgedRequiredHookRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedRequiredHookRocmDir, 'real-rocm-forged-required-hook.json'), {
  slug: 'gpu-real-rocm-forged-required-hook-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-required-hook' },
  source_url: 'https://example.invalid/rocm/forged-required-hook.git',
  repo_commit: 'cdef0123456789abcdef0123456789abcdef0123',
  entry_file: 'src/kernels/required_hook_entry.hip',
  delta_file: 'src/kernels/required_hook_delta.h',
  target_name: 'ForgedRequiredHookDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    selectedSource: 'profile_runtime_profile',
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  real_rocm_app_hook_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_contract_facet.v1',
    declared: true,
    required: true,
    status: 'declared_app_hook_pending_runtime_observation',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: false,
    runtime_observation_complete: false,
    blockingGaps: ['app_hook_dispatch_trace_runtime_not_observed'],
    blocking_gaps: ['app_hook_dispatch_trace_runtime_not_observed'],
  },
  real_rocm_compile_bridge: {
    schemaVersion: 'synthi.real_rocm.compile_bridge_facet.v1',
    status: 'compile_bridge_candidate_observed_not_runtime_proof',
    proofAuthority: 'compile_response_evidence_only_not_gpu_hmr_success',
    proof_authority: 'compile_response_evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    phaseCount: 1,
    phase_count: 1,
    blockingGaps: ['compile_response_bridge_candidate_not_runtime_proof'],
    blocking_gaps: ['compile_response_bridge_candidate_not_runtime_proof'],
  },
  real_rocm_device_sidecar_contract: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract_facet.v1',
    declared: true,
    required: true,
    status: 'declared_device_sidecar_contract_not_runtime_proof',
    proofAuthority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    proof_authority: 'build_metadata_candidate_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: false,
    runtime_observation_complete: false,
    sourceCoverageComplete: true,
    source_coverage_complete: true,
    backend: 'hip',
    artifact_identity: {
      source_paths: ['src/kernels/required_hook_entry.hip'],
      artifact_kind: 'hsaco',
      entry_points: ['required_hook_kernel'],
      compile_target: 'gfx1201',
      compiler: '/opt/rocm/llvm/bin/amdclang++',
      compiler_args_hash: hashValue('forged-required-hook-sidecar-compile-args'),
    },
    blockingGaps: [
      'device_sidecar_dispatch_trace_runtime_not_observed',
    ],
    blocking_gaps: [
      'device_sidecar_dispatch_trace_runtime_not_observed',
    ],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-forged-required-hook',
    visualRoot: forgedRequiredHookRocmDir,
  }),
  visual_artifact_paths: [
    path.join(forgedRequiredHookRocmDir, 'before-hmr-first.png'),
    path.join(forgedRequiredHookRocmDir, 'after-hmr-first.png'),
    path.join(forgedRequiredHookRocmDir, 'before-after-diff.png'),
  ],
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-required-hook-delta',
    editHash: hashValue('real-rocm-forged-required-hook-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-required-hook.git @ cdef012345 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedRequiredHookRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRequiredHookRocmDir],
  generatedAt: '2026-06-09T00:00:02.125Z',
  includeUnproven: true,
});
const forgedRequiredHookRocm = forgedRequiredHookRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedRequiredHookRocm?.matrixOutcome, 'unproven');
assert.equal(forgedRequiredHookRocm.acceptedForGpuHmr, false);
assert.equal(forgedRequiredHookRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedRequiredHookRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedRequiredHookRocm.outputOracleFacet.accepted, true);
assert.equal(forgedRequiredHookRocm.realRocmAppHookContract.declared, true);
assert.equal(forgedRequiredHookRocm.realRocmAppHookContract.canSatisfyRuntimeProof, false);
assert.equal(forgedRequiredHookRocm.realRocmDeviceSidecarContract.declared, true);
assert.equal(forgedRequiredHookRocm.realRocmDeviceSidecarContract.canSatisfyRuntimeProof, false);
assert.equal(forgedRequiredHookRocm.realRocmCompileBridge.canSatisfyRuntimeProof, false);
assert.ok(forgedRequiredHookRocm.reasons.includes('real_rocm_app_hook_contract_required_not_proven'));
assert.ok(forgedRequiredHookRocm.reasons.includes(
  'real_rocm_device_sidecar_contract:declared_device_sidecar_contract_not_runtime_proof',
));
assert.ok(forgedRequiredHookRocm.reasons.includes('real_rocm_compile_bridge:compile_bridge_candidate_observed_not_runtime_proof'));
assert.ok(forgedRequiredHookRocm.openGaps.includes('real_rocm_app_hook_contract_required'));
assert.ok(forgedRequiredHookRocm.openGaps.includes(
  'real_rocm_device_sidecar_contract:device_sidecar_dispatch_trace_runtime_not_observed',
));
assert.ok(forgedRequiredHookRocm.openGaps.includes(
  'real_rocm_compile_bridge:compile_response_bridge_candidate_not_runtime_proof',
));

const forgedMissingHookFacetRocmDir = path.join(logsRoot, 'real-rocm-forged-missing-hook-facet');
await writeRgbaPng(path.join(forgedMissingHookFacetRocmDir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(forgedMissingHookFacetRocmDir, 'after-hmr-first.png'), 8, 8, (x, y) => [32 + x, 96 + y, 180, 255]);
await writeRgbaPng(path.join(forgedMissingHookFacetRocmDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedMissingHookFacetRocmDir, 'real-rocm-forged-missing-hook-facet.json'), {
  slug: 'gpu-real-rocm-forged-missing-hook-facet-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-missing-hook-facet' },
  source_url: 'https://example.invalid/rocm/forged-missing-hook-facet.git',
  repo_commit: 'fedcba9876543210fedcba9876543210fedcba98',
  entry_file: 'src/kernels/missing_hook_entry.hip',
  delta_file: 'src/kernels/missing_hook_delta.h',
  target_name: 'ForgedMissingHookFacetDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    selectedSource: 'profile_runtime_profile',
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: false,
    phaseRaw: 'small-oracle',
    phase: 'small-oracle',
    recognized: true,
    reason: null,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=small-oracle' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  native_rocm_launch_boundary: {
    schemaVersion: 'synthi.gpu_hmr.native_rocm_launch_boundary_refusal.v1',
    observed: true,
    status: 'refusal_evidence',
    adapterOutcome: 'adapter_impossible_requires_app_hook',
    adapter_outcome: 'adapter_impossible_requires_app_hook',
    blockingGaps: ['adapter_impossible_requires_app_hook'],
    blocking_gaps: ['adapter_impossible_requires_app_hook'],
  },
  real_rocm_runtime_eligibility: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_eligibility.v1',
    status: 'refused_missing_runtime_proof',
    appHookContractStatus: 'required_app_hook_contract_missing',
    app_hook_contract_status: 'required_app_hook_contract_missing',
    blockingGaps: ['app_hook_contract_not_declared'],
    blocking_gaps: ['app_hook_contract_not_declared'],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-forged-missing-hook-facet',
    visualRoot: forgedMissingHookFacetRocmDir,
  }),
  visual_artifact_paths: [
    path.join(forgedMissingHookFacetRocmDir, 'before-hmr-first.png'),
    path.join(forgedMissingHookFacetRocmDir, 'after-hmr-first.png'),
    path.join(forgedMissingHookFacetRocmDir, 'before-after-diff.png'),
  ],
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-missing-hook-facet-delta',
    editHash: hashValue('real-rocm-forged-missing-hook-facet-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-missing-hook-facet.git @ fedcba9 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedMissingHookFacetRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedMissingHookFacetRocmDir],
  generatedAt: '2026-06-09T00:00:02.126Z',
  includeUnproven: true,
});
const forgedMissingHookFacetRocm = forgedMissingHookFacetRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedMissingHookFacetRocm?.matrixOutcome, 'unproven');
assert.equal(forgedMissingHookFacetRocm.acceptedForGpuHmr, false);
assert.equal(forgedMissingHookFacetRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedMissingHookFacetRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedMissingHookFacetRocm.outputOracleFacet.accepted, true);
assert.deepEqual(forgedMissingHookFacetRocm.realRocmAppHookContract, {});
assert.ok(forgedMissingHookFacetRocm.reasons.includes('real_rocm_app_hook_contract_required_not_proven'));
assert.ok(forgedMissingHookFacetRocm.openGaps.includes('real_rocm_app_hook_contract_required'));

const acceptedComputeRocmDir = path.join(logsRoot, 'real-rocm-accepted-compute-lib');
const acceptedComputeRawReadback = path.join(acceptedComputeRocmDir, 'readback.bin');
const acceptedComputeBytes = Buffer.from([1, 7, 23, 42, 88, 111, 4, 19]);
await fs.mkdir(acceptedComputeRocmDir, { recursive: true });
await fs.writeFile(acceptedComputeRawReadback, acceptedComputeBytes);
await writeJson(`${acceptedComputeRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: acceptedComputeBytes.length,
  shape: [acceptedComputeBytes.length],
});
await writeRgbaPng(`${acceptedComputeRawReadback}.card.png`, 8, 8, (x, y) => [
  acceptedComputeBytes[(x + y) % acceptedComputeBytes.length],
  64 + x,
  120 + y,
  255,
]);
const acceptedComputeProofMaterials = realRocmComputeProofLedgerMaterials('accepted-compute-files', {
  projectId: 'real-rocm-accepted-compute-lib',
  rawReadbackPath: acceptedComputeRawReadback,
  rawReadbackBytes: acceptedComputeBytes,
});
await writeJson(path.join(acceptedComputeRocmDir, 'real-rocm-accepted-compute.json'), {
  slug: 'gpu-real-rocm-accepted-compute-lib-20260623',
  real_rocm_profile: { id: 'real-rocm-accepted-compute-lib' },
  source_url: 'https://example.invalid/rocm/accepted-compute.git',
  repo_commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'AcceptedComputeDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...acceptedComputeProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-compute-lib-delta',
    editHash: hashValue('real-rocm-accepted-compute-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-compute.git @ bbbbbbbb files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedComputeRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedComputeRocmDir],
  generatedAt: '2026-06-09T00:00:02.250Z',
  includeUnproven: true,
});
const acceptedComputeRocm = acceptedComputeRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedComputeRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedComputeRocm.acceptedForGpuHmr, true);
assert.equal(acceptedComputeRocm.runtimeProofArtifact.accepted, true);
assert.equal(acceptedComputeRocm.ledger.gpuHmrSuccess, true);
assert.equal(acceptedComputeRocm.visual.present, false);
assert.equal(acceptedComputeRocm.outputOracleFacet.kind, 'compute_oracle');
assert.equal(acceptedComputeRocm.outputOracleFacet.accepted, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.rawReadbackHashVerified, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.rawReadbackByteLength, acceptedComputeBytes.length);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.deterministicSliceHashVerified, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.readbackSchemaByteLength > 0, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.renderedCard.decoded, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.renderedCard.format, 'png');
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.accepted, true);
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.selectedLoaderTransport, 'ram_bytes');
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.runtimeSessionId, 'runtime-session:accepted-compute-files');
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.dispatchTableEntryId, 'dispatch-table-entry:accepted-compute-files');
assert.equal(acceptedComputeRocm.realRocmRuntimeChain.outputTargetId, 'output-target:accepted-compute-files');
assert.equal(acceptedComputeRocm.realRocmRuntimeCapabilityPreflight.present, true);
assert.equal(acceptedComputeRocm.realRocmRuntimeCapabilityPreflight.accepted, true);

const forgedRuntimeChainMismatchRocmDir = path.join(logsRoot, 'real-rocm-forged-runtime-chain-mismatch');
const forgedRuntimeChainMismatchProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-runtime-chain-mismatch',
  {
    projectId: 'real-rocm-forged-runtime-chain-mismatch',
    rawReadbackPath: acceptedComputeRawReadback,
    rawReadbackBytes: acceptedComputeBytes,
    outputRuntimeSessionId: 'runtime-session:wrong-output-session',
  },
);
await writeJson(path.join(forgedRuntimeChainMismatchRocmDir, 'real-rocm-forged-runtime-chain-mismatch.json'), {
  slug: 'gpu-real-rocm-forged-runtime-chain-mismatch-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-runtime-chain-mismatch' },
  source_url: 'https://example.invalid/rocm/forged-runtime-chain-mismatch.git',
  repo_commit: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'ForgedRuntimeChainMismatchDriver',
  gpu_vendor: 'rocm',
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'profile.tensor.checksum.v1',
    mode: 'profile.tensor.checksum.v1',
    sourceDerivedCandidateCount: 0,
    selectedSource: 'profile_runtime_profile',
    disabledReason: null,
    failedReason: null,
    contractPresent: true,
    runtimeProfilePresent: true,
    runtimeProfileSynced: true,
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedRuntimeChainMismatchProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-runtime-chain-mismatch-delta',
    editHash: hashValue('real-rocm-forged-runtime-chain-mismatch-delta'),
  },
  checks: [
    {
      name: 'real ROCm repo',
      status: 'pass',
      detail: 'https://example.invalid/rocm/forged-runtime-chain-mismatch.git @ cdcdcdcd files=18000',
    },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedRuntimeChainMismatchRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRuntimeChainMismatchRocmDir],
  generatedAt: '2026-06-09T00:00:02.255Z',
  includeUnproven: true,
});
const forgedRuntimeChainMismatchRocm = forgedRuntimeChainMismatchRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedRuntimeChainMismatchRocm?.matrixOutcome, 'unproven');
assert.equal(forgedRuntimeChainMismatchRocm.acceptedForGpuHmr, false);
assert.equal(forgedRuntimeChainMismatchRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedRuntimeChainMismatchRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedRuntimeChainMismatchRocm.outputOracleFacet.accepted, true);
assert.equal(forgedRuntimeChainMismatchRocm.outputOracleResolutionGate.accepted, true);
assert.equal(forgedRuntimeChainMismatchRocm.realRocmRuntimeChain.accepted, false);
assert.ok(forgedRuntimeChainMismatchRocm.reasons.includes(
  'real_rocm_runtime_chain_session_mismatch',
));
assert.ok(forgedRuntimeChainMismatchRocm.openGaps.includes('real_rocm_runtime_chain_required'));

async function writeForgedRuntimeChainCase({ slug, mutateRecord, expectedReason }) {
  const dir = path.join(logsRoot, `real-rocm-forged-runtime-chain-${slug}`);
  const scope = `forged-runtime-chain-${slug}`;
  const materials = realRocmComputeProofLedgerMaterials(scope, {
    projectId: `real-rocm-forged-runtime-chain-${slug}`,
    rawReadbackPath: acceptedComputeRawReadback,
    rawReadbackBytes: acceptedComputeBytes,
  });
  const mutatedRecord = structuredClone(materials.proofLedger.records[0]);
  mutateRecord(mutatedRecord);
  const proofLedger = buildGpuHmrProofLedger(mutatedRecord);
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  materials.proofLedger = proofLedger;
  materials.proof_ledger = proofLedger;
  materials.proofLedgerQuery = proofLedgerQuery;
  materials.proof_ledger_query = proofLedgerQuery;
  materials.runtimeProofArtifact.proofLedger = proofLedger;
  materials.runtimeProofArtifact.proofLedgerQuery = proofLedgerQuery;
  materials.runtime_proof_artifact.proofLedger = proofLedger;
  materials.runtime_proof_artifact.proofLedgerQuery = proofLedgerQuery;
  await writeJson(path.join(dir, `real-rocm-forged-runtime-chain-${slug}.json`), {
    slug: `gpu-real-rocm-forged-runtime-chain-${slug}-20260623`,
    real_rocm_profile: { id: `real-rocm-forged-runtime-chain-${slug}` },
    source_url: `https://example.invalid/rocm/forged-runtime-chain-${slug}.git`,
    repo_commit: 'cececececececececececececececececececece',
    entry_file: 'src/kernels/compute_entry.hip',
    delta_file: 'src/kernels/compute_delta.h',
    target_name: `ForgedRuntimeChain${slug}`,
    gpu_vendor: 'rocm',
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_oracle_resolution: {
      schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
      requestedProfile: 'profile.tensor.checksum.v1',
      mode: 'profile.tensor.checksum.v1',
      sourceDerivedCandidateCount: 0,
      selectedSource: 'profile_runtime_profile',
      disabledReason: null,
      failedReason: null,
      contractPresent: true,
      runtimeProfilePresent: true,
      runtimeProfileSynced: true,
    },
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    ...materials,
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: `real-rocm-forged-runtime-chain-${slug}-delta`,
      editHash: hashValue(`real-rocm-forged-runtime-chain-${slug}-delta`),
    },
    checks: [
      {
        name: 'real ROCm repo',
        status: 'pass',
        detail: `https://example.invalid/rocm/forged-runtime-chain-${slug}.git @ cececece files=18000`,
      },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  });
  const ledger = await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [dir],
    generatedAt: '2026-06-09T00:00:02.260Z',
    includeUnproven: true,
  });
  const row = ledger.rows.find((entry) => entry.proofMode === 'real_rocm_repo_validation');
  assert.equal(row?.matrixOutcome, 'unproven');
  assert.equal(row.acceptedForGpuHmr, false);
  assert.equal(row.runtimeProofArtifact.accepted, true);
  assert.equal(row.ledger.gpuHmrSuccess, true);
  assert.equal(row.outputOracleFacet.accepted, true);
  assert.equal(row.outputOracleResolutionGate.accepted, true);
  assert.equal(row.realRocmRuntimeChain.accepted, false);
  assert.ok(row.reasons.includes(expectedReason));
  assert.ok(row.openGaps.includes('real_rocm_runtime_chain_required'));
  return row;
}

await writeForgedRuntimeChainCase({
  slug: 'missing-dispatch-session',
  expectedReason: 'real_rocm_runtime_chain_session_missing',
  mutateRecord(record) {
    if (record.dispatchEvent) delete record.dispatchEvent.runtime_session_id;
    if (record.dispatch_event) delete record.dispatch_event.runtime_session_id;
  },
});
await writeForgedRuntimeChainCase({
  slug: 'missing-transport-hash',
  expectedReason: 'real_rocm_runtime_chain_transport_hash_missing',
  mutateRecord(record) {
    if (record.loaderEvent?.artifact_transport) {
      delete record.loaderEvent.artifact_transport.artifact_hash;
      delete record.loaderEvent.artifact_transport.blob_digest;
    }
    if (record.loader_event?.artifact_transport) {
      delete record.loader_event.artifact_transport.artifact_hash;
      delete record.loader_event.artifact_transport.blob_digest;
    }
  },
});
await writeForgedRuntimeChainCase({
  slug: 'missing-output-target',
  expectedReason: 'real_rocm_runtime_chain_output_target_missing',
  mutateRecord(record) {
    if (record.outputEvent) delete record.outputEvent.output_target_id;
    if (record.output_event) delete record.output_event.output_target_id;
  },
});

const forgedMissingUnflaggedResolutionRocmDir = path.join(
  logsRoot,
  'real-rocm-forged-missing-unflagged-resolution',
);
const forgedMissingUnflaggedResolutionProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-missing-unflagged-resolution',
  {
    projectId: 'real-rocm-forged-missing-unflagged-resolution',
    rawReadbackPath: acceptedComputeRawReadback,
    rawReadbackBytes: acceptedComputeBytes,
  },
);
await writeJson(
  path.join(forgedMissingUnflaggedResolutionRocmDir, 'real-rocm-forged-missing-unflagged-resolution.json'),
  {
    slug: 'gpu-real-rocm-forged-missing-unflagged-resolution-20260623',
    real_rocm_profile: { id: 'real-rocm-forged-missing-unflagged-resolution' },
    source_url: 'https://example.invalid/rocm/forged-missing-unflagged-resolution.git',
    repo_commit: 'bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc',
    entry_file: 'src/kernels/compute_entry.hip',
    delta_file: 'src/kernels/compute_delta.h',
    target_name: 'ForgedMissingUnflaggedResolutionDriver',
    gpu_vendor: 'rocm',
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    ...forgedMissingUnflaggedResolutionProofMaterials,
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: 'real-rocm-forged-missing-unflagged-resolution-delta',
      editHash: hashValue('real-rocm-forged-missing-unflagged-resolution-delta'),
    },
    checks: [
      {
        name: 'real ROCm repo',
        status: 'pass',
        detail: 'https://example.invalid/rocm/forged-missing-unflagged-resolution.git @ bcbcbcbc files=18000',
      },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  },
);
const forgedMissingUnflaggedResolutionRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedMissingUnflaggedResolutionRocmDir],
  generatedAt: '2026-06-09T00:00:02.260Z',
  includeUnproven: true,
});
const forgedMissingUnflaggedResolutionRocm = forgedMissingUnflaggedResolutionRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedMissingUnflaggedResolutionRocm?.matrixOutcome, 'unproven');
assert.equal(forgedMissingUnflaggedResolutionRocm.acceptedForGpuHmr, false);
assert.equal(forgedMissingUnflaggedResolutionRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedMissingUnflaggedResolutionRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedMissingUnflaggedResolutionRocm.outputOracleFacet.accepted, true);
assert.equal(forgedMissingUnflaggedResolutionRocm.outputOracleResolutionGate.required, true);
assert.equal(forgedMissingUnflaggedResolutionRocm.outputOracleResolutionGate.accepted, false);
assert.ok(forgedMissingUnflaggedResolutionRocm.reasons.includes(
  'real_rocm_output_oracle_resolution_missing',
));
assert.ok(forgedMissingUnflaggedResolutionRocm.openGaps.includes(
  'real_rocm_output_oracle_resolution_required',
));

const forgedMissingResolutionRocmDir = path.join(logsRoot, 'real-rocm-forged-missing-resolution');
const forgedMissingResolutionProofMaterials = realRocmComputeProofLedgerMaterials('forged-missing-resolution', {
  projectId: 'real-rocm-forged-missing-resolution',
  rawReadbackPath: acceptedComputeRawReadback,
  rawReadbackBytes: acceptedComputeBytes,
});
await writeJson(path.join(forgedMissingResolutionRocmDir, 'real-rocm-forged-missing-resolution.json'), {
  slug: 'gpu-real-rocm-forged-missing-resolution-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-missing-resolution' },
  source_url: 'https://example.invalid/rocm/forged-missing-resolution.git',
  repo_commit: 'abababababababababababababababababababab',
  entry_file: 'src/kernels/missing_resolution_entry.hip',
  delta_file: 'src/kernels/missing_resolution_delta.h',
  target_name: 'ForgedMissingResolutionDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedMissingResolutionProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-missing-resolution-delta',
    editHash: hashValue('real-rocm-forged-missing-resolution-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-missing-resolution.git @ abababab files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedMissingResolutionRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedMissingResolutionRocmDir],
  generatedAt: '2026-06-09T00:00:02.260Z',
  includeUnproven: true,
});
const forgedMissingResolutionRocm = forgedMissingResolutionRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedMissingResolutionRocm?.matrixOutcome, 'unproven');
assert.equal(forgedMissingResolutionRocm.acceptedForGpuHmr, false);
assert.equal(forgedMissingResolutionRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedMissingResolutionRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedMissingResolutionRocm.outputOracleFacet.accepted, true);
assert.equal(forgedMissingResolutionRocm.outputOracleResolutionGate.accepted, false);
assert.ok(forgedMissingResolutionRocm.reasons.includes('real_rocm_output_oracle_resolution_missing'));
assert.ok(forgedMissingResolutionRocm.reasons.includes('real_rocm_output_oracle_resolution_not_accepted'));
assert.ok(forgedMissingResolutionRocm.openGaps.includes('real_rocm_output_oracle_resolution_required'));

const forgedFinalNoOracleRocmDir = path.join(logsRoot, 'real-rocm-forged-final-no-oracle');
const forgedFinalNoOracleRawReadback = path.join(forgedFinalNoOracleRocmDir, 'readback.bin');
const forgedFinalNoOracleBytes = Buffer.from([13, 21, 34, 55, 89, 144, 233, 1]);
await fs.mkdir(forgedFinalNoOracleRocmDir, { recursive: true });
await fs.writeFile(forgedFinalNoOracleRawReadback, forgedFinalNoOracleBytes);
await writeJson(`${forgedFinalNoOracleRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedFinalNoOracleBytes.length,
  shape: [forgedFinalNoOracleBytes.length],
});
await writeRgbaPng(`${forgedFinalNoOracleRawReadback}.card.png`, 8, 8, (x, y) => [
  forgedFinalNoOracleBytes[(x + y) % forgedFinalNoOracleBytes.length],
  70 + x,
  90 + y,
  255,
]);
const forgedFinalNoOracleProofMaterials = realRocmComputeProofLedgerMaterials('forged-final-no-oracle', {
  projectId: 'real-rocm-forged-final-no-oracle',
  rawReadbackPath: forgedFinalNoOracleRawReadback,
  rawReadbackBytes: forgedFinalNoOracleBytes,
});
await writeJson(path.join(forgedFinalNoOracleRocmDir, 'real-rocm-forged-final-no-oracle.json'), {
  slug: 'gpu-real-rocm-forged-final-no-oracle-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-final-no-oracle' },
  source_url: 'https://example.invalid/rocm/forged-final-no-oracle.git',
  repo_commit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  entry_file: 'src/kernels/final_entry.hip',
  delta_file: 'src/kernels/final_delta.h',
  target_name: 'ForgedFinalDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_oracle_resolution: {
    schemaVersion: 'synthi.real_rocm.output_oracle_resolution.v1',
    requestedProfile: 'none',
    mode: 'none',
    selectedSource: 'none',
    disabledReason: 'profile_disabled',
    failedReason: null,
    contractPresent: false,
    runtimeProfilePresent: false,
    runtimeProfileSynced: false,
  },
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedFinalDriver',
    finalAcceptanceTarget: 'ForgedFinalDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  real_rocm_profile_proof_obligations: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations.v1',
    status: 'profile_proof_obligations_met',
    requiresFullRuntimeProof: true,
    requires_full_runtime_proof: true,
    blockingGaps: [],
    blocking_gaps: [],
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedFinalNoOracleProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-final-no-oracle-delta',
    editHash: hashValue('real-rocm-forged-final-no-oracle-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-final-no-oracle.git @ eeeeeeee files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedFinalNoOracleRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedFinalNoOracleRocmDir],
  generatedAt: '2026-06-09T00:00:02.275Z',
  includeUnproven: true,
});
const forgedFinalNoOracleRocm = forgedFinalNoOracleRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedFinalNoOracleRocm?.matrixOutcome, 'unproven');
assert.equal(forgedFinalNoOracleRocm.acceptedForGpuHmr, false);
assert.equal(forgedFinalNoOracleRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedFinalNoOracleRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedFinalNoOracleRocm.outputOracleFacet.accepted, true);
assert.equal(forgedFinalNoOracleRocm.outputOracleResolutionGate.accepted, false);
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_profile_disabled'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_contract_missing'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_runtime_profile_missing'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_runtime_profile_not_synced'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_source_missing'));
assert.ok(forgedFinalNoOracleRocm.reasons.includes('real_rocm_output_oracle_resolution_not_accepted'));
assert.ok(forgedFinalNoOracleRocm.openGaps.includes('real_rocm_output_oracle_resolution_required'));

const forgedMissingRequiredHookRocmDir = path.join(logsRoot, 'real-rocm-forged-missing-required-hook');
const forgedMissingRequiredHookRawReadback = path.join(forgedMissingRequiredHookRocmDir, 'readback.bin');
const forgedMissingRequiredHookBytes = Buffer.from([3, 6, 9, 12, 15, 18, 21, 24]);
await fs.mkdir(forgedMissingRequiredHookRocmDir, { recursive: true });
await fs.writeFile(forgedMissingRequiredHookRawReadback, forgedMissingRequiredHookBytes);
await writeJson(`${forgedMissingRequiredHookRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedMissingRequiredHookBytes.length,
  shape: [forgedMissingRequiredHookBytes.length],
});
await writeRgbaPng(`${forgedMissingRequiredHookRawReadback}.card.png`, 8, 8, (x, y) => [
  forgedMissingRequiredHookBytes[(x + y) % forgedMissingRequiredHookBytes.length],
  88 + x,
  104 + y,
  255,
]);
const forgedMissingRequiredHookProofMaterials = realRocmComputeProofLedgerMaterials('forged-missing-required-hook', {
  projectId: 'real-rocm-forged-missing-required-hook',
  rawReadbackPath: forgedMissingRequiredHookRawReadback,
  rawReadbackBytes: forgedMissingRequiredHookBytes,
});
await writeJson(path.join(forgedMissingRequiredHookRocmDir, 'real-rocm-forged-missing-required-hook.json'), {
  slug: 'gpu-real-rocm-forged-missing-required-hook-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-missing-required-hook' },
  source_url: 'https://example.invalid/rocm/forged-missing-required-hook.git',
  repo_commit: 'dddddddddddddddddddddddddddddddddddddddd',
  entry_file: 'src/kernels/required_hook_entry.hip',
  delta_file: 'src/kernels/required_hook_delta.h',
  target_name: 'ForgedMissingRequiredHookDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  real_rocm_profile_proof_obligations: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations.v1',
    status: 'profile_proof_obligations_met',
    requiresAppHookContract: true,
    requires_app_hook_contract: true,
    blockingGaps: [],
    blocking_gaps: [],
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedMissingRequiredHookProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-missing-required-hook-delta',
    editHash: hashValue('real-rocm-forged-missing-required-hook-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-missing-required-hook.git @ dddddddd files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedMissingRequiredHookRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedMissingRequiredHookRocmDir],
  generatedAt: '2026-06-09T00:00:02.300Z',
  includeUnproven: true,
});
const forgedMissingRequiredHookRocm = forgedMissingRequiredHookRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedMissingRequiredHookRocm?.matrixOutcome, 'unproven');
assert.equal(forgedMissingRequiredHookRocm.acceptedForGpuHmr, false);
assert.equal(forgedMissingRequiredHookRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedMissingRequiredHookRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedMissingRequiredHookRocm.outputOracleFacet.accepted, true);
assert.equal(forgedMissingRequiredHookRocm.realRocmAppHookContractGate.required, true);
assert.equal(forgedMissingRequiredHookRocm.realRocmAppHookContractGate.missing, true);
assert.ok(forgedMissingRequiredHookRocm.reasons.includes('real_rocm_app_hook_contract_required_not_proven'));
assert.ok(forgedMissingRequiredHookRocm.reasons.includes('real_rocm_app_hook_contract_missing'));
assert.ok(forgedMissingRequiredHookRocm.openGaps.includes('real_rocm_app_hook_contract_required'));
assert.ok(forgedMissingRequiredHookRocm.openGaps.includes('real_rocm_app_hook_contract_missing'));

const forgedTargetProgressionRocmDir = path.join(logsRoot, 'real-rocm-forged-target-progression-failure');
const forgedTargetProgressionRawReadback = path.join(forgedTargetProgressionRocmDir, 'readback.bin');
const forgedTargetProgressionBytes = Buffer.from([5, 10, 15, 20, 25, 30, 35, 40]);
await fs.mkdir(forgedTargetProgressionRocmDir, { recursive: true });
await fs.writeFile(forgedTargetProgressionRawReadback, forgedTargetProgressionBytes);
await writeJson(`${forgedTargetProgressionRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedTargetProgressionBytes.length,
  shape: [forgedTargetProgressionBytes.length],
});
await writeRgbaPng(`${forgedTargetProgressionRawReadback}.card.png`, 8, 8, (x, y) => [
  forgedTargetProgressionBytes[(x + y) % forgedTargetProgressionBytes.length],
  72 + x,
  96 + y,
  255,
]);
const forgedTargetProgressionProofMaterials = realRocmComputeProofLedgerMaterials('forged-target-progression-failure', {
  projectId: 'real-rocm-forged-target-progression-failure',
  rawReadbackPath: forgedTargetProgressionRawReadback,
  rawReadbackBytes: forgedTargetProgressionBytes,
});
await writeJson(path.join(forgedTargetProgressionRocmDir, 'real-rocm-forged-target-progression-failure.json'), {
  slug: 'gpu-real-rocm-forged-target-progression-failure-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-target-progression-failure' },
  source_url: 'https://example.invalid/rocm/forged-target-progression.git',
  repo_commit: 'cccccccccccccccccccccccccccccccccccccccc',
  entry_file: 'src/kernels/progression_entry.hip',
  delta_file: 'src/kernels/progression_delta.h',
  target_name: 'ForgedProgressionDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  target_progression_gates: [
    {
      name: 'target progression prior partial-reload',
      status: 'fail',
      detail: 'prior phase partial-reload proof missing from target progression ledger',
    },
  ],
  ...forgedTargetProgressionProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-target-progression-failure-delta',
    editHash: hashValue('real-rocm-forged-target-progression-failure-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-target-progression.git @ cccccccc files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedTargetProgressionRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedTargetProgressionRocmDir],
  generatedAt: '2026-06-09T00:00:02.375Z',
  includeUnproven: true,
});
const forgedTargetProgressionRocm = forgedTargetProgressionRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedTargetProgressionRocm?.matrixOutcome, 'unproven');
assert.equal(forgedTargetProgressionRocm.acceptedForGpuHmr, false);
assert.equal(forgedTargetProgressionRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedTargetProgressionRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedTargetProgressionRocm.outputOracleFacet.accepted, true);
assert.ok(forgedTargetProgressionRocm.reasons.includes(
  'target_progression_gate_failed:target progression prior partial-reload',
));
assert.ok(forgedTargetProgressionRocm.openGaps.includes('target_progression_gates_failed'));

const forgedComputeRocmDir = path.join(logsRoot, 'real-rocm-forged-compute-missing-raw');
const forgedComputeRawReadback = path.join(forgedComputeRocmDir, 'missing-readback.bin');
const forgedComputeProofMaterials = realRocmComputeProofLedgerMaterials('forged-compute-missing-raw', {
  projectId: 'real-rocm-forged-compute-missing-raw',
  rawReadbackPath: forgedComputeRawReadback,
});
await writeJson(path.join(forgedComputeRocmDir, 'real-rocm-forged-compute-missing-raw.json'), {
  slug: 'gpu-real-rocm-forged-compute-missing-raw-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-compute-missing-raw' },
  source_url: 'https://example.invalid/rocm/forged-compute.git',
  repo_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'ForgedComputeDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedComputeProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-compute-missing-raw-delta',
    editHash: hashValue('real-rocm-forged-compute-missing-raw-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-compute.git @ aaaaaaaa files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedComputeRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedComputeRocmDir],
  generatedAt: '2026-06-09T00:00:02.500Z',
  includeUnproven: true,
});
const forgedComputeRocm = forgedComputeRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedComputeRocm?.matrixOutcome, 'unproven');
assert.equal(forgedComputeRocm.acceptedForGpuHmr, false);
assert.equal(forgedComputeRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedComputeRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedComputeRocm.outputOracleFacet.kind, 'compute_oracle');
assert.equal(forgedComputeRocm.outputOracleFacet.accepted, false);
assert.equal(forgedComputeRocm.outputOracleFacet.compute.present, true);
assert.equal(forgedComputeRocm.outputOracleFacet.compute.rawReadbackHashVerified, false);
assert.equal(forgedComputeRocm.outputOracleFacet.compute.deterministicSliceHashVerified, false);
assert.ok(forgedComputeRocm.outputOracleFacet.compute.rawReadbackReadError);
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_raw_readback_hash_unverified'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_raw_readback_bytes_missing'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_deterministic_slice_hash_unverified'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_raw_readback_unreadable'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_readback_schema_bytes_missing'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_readback_schema_unreadable'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_rendered_card_decode_failed'));
assert.ok(forgedComputeRocm.reasons.includes('compute_oracle_rendered_card_not_png'));
assert.ok(forgedComputeRocm.reasons.includes('output_or_visual_oracle_proof_missing'));

const forgedRealRocmDir = path.join(logsRoot, 'real-rocm-forged-no-oracle');
await writeJson(path.join(forgedRealRocmDir, 'real-rocm-forged-no-oracle.json'), {
  slug: 'gpu-real-rocm-forged-no-oracle-20260623',
  real_rocm_profile: { id: 'real-rocm-forged-no-oracle' },
  source_url: 'https://example.invalid/rocm/forged-lib.git',
  repo_commit: 'fedcba9876543210fedcba9876543210fedcba98',
  entry_file: 'src/kernels/forged_entry.hip',
  delta_file: 'src/kernels/forged_delta.h',
  target_name: 'ForgedRocmDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: 'real-rocm-forged-no-oracle',
    visualRoot: forgedRealRocmDir,
  }),
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-no-oracle-delta',
    editHash: hashValue('real-rocm-forged-no-oracle-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-lib.git @ fedcba987654 files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedRealRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRealRocmDir],
  generatedAt: '2026-06-09T00:00:03.000Z',
  includeUnproven: true,
});
const forgedRealRocm = forgedRealRocmLedger.rows.find((row) => row.proofMode === 'real_rocm_repo_validation');
assert.equal(forgedRealRocm?.matrixOutcome, 'unproven');
assert.equal(forgedRealRocm.acceptedForGpuHmr, false);
assert.equal(forgedRealRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedRealRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedRealRocm.visual.present, false);
assert.ok(forgedRealRocm.reasons.includes('output_or_visual_oracle_proof_missing'));

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  proofId: ledger.proofId,
  rows: ledger.rows.length,
}, null, 2));
