#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  buildGpuHmrValidationMatrixLedger,
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
  buildGpuHmrRunModeCoverageSupport,
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

function fileHashForPath(filePath) {
  return hashBuffer(fsSync.readFileSync(filePath));
}

function visualArtifactSet({ before, after, diff, diagnosticScreenshot } = {}, extra = {}) {
  return {
    ...(before
      ? {
          beforeImage: before,
          beforeImageHash: fileHashForPath(before),
        }
      : {}),
    ...(after
      ? {
          afterImage: after,
          afterImageHash: fileHashForPath(after),
        }
      : {}),
    ...(diff
      ? {
          diffImage: diff,
          diffImageHash: fileHashForPath(diff),
        }
      : {}),
    ...(diagnosticScreenshot
      ? {
          diagnosticScreenshot,
          diagnosticScreenshotHash: fileHashForPath(diagnosticScreenshot),
        }
      : {}),
    ...extra,
  };
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
  backend = 'hip',
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
    expected_output_verified: true,
    expected_output_source: 'runtime_checksum_oracle',
    output_change_expected: true,
  };
  const proofLedger = buildGpuHmrProofLedger({
    project_id: projectId,
    edit_id: `source-edit:${scope}`,
    backend,
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
    device_identity: { device_uuid: 'gpu:synthetic-rocm', backend },
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
      baseline: {
        localCapturePath: baselinePath,
        contentHash: fileHashForPath(baselinePath),
      },
      changed: {
        localCapturePath: changedPath,
        contentHash: fileHashForPath(changedPath),
        sameProcess: true,
        liveRecompileMs: 1,
        totalHostWallMs: 2,
      },
    },
    diff: {
      path: diffPath,
      contentHash: fileHashForPath(diffPath),
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
  visualArtifacts: visualArtifactSet({
    before: path.join(visualDir, 'before-hmr-first.png'),
    after: path.join(visualDir, 'after-hmr-first.png'),
    diff: path.join(visualDir, 'before-after-diff.png'),
  }),
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

function runModeCoverageSupportFor(materials, extraProofIds = [], options = {}) {
  const record = materials.proofLedgerQuery?.record ?? materials.proofLedger?.records?.[0] ?? {};
  const support = buildGpuHmrRunModeCoverageSupport({
    proofLedger: materials.proofLedger,
    proofLedgerQuery: materials.proofLedgerQuery,
    runtimeProofArtifact: materials.runtimeProofArtifact,
    parentProofIds: extraProofIds,
  });
  const artifactAfterHash = record.artifactAfterHash ?? record.artifact_after_hash;
  const namespaceArtifactAfterHash = options.namespaceArtifactAfterHash !== false;
  const selectedArtifactAfterHash = namespaceArtifactAfterHash && String(artifactAfterHash ?? '').startsWith('sha256:')
    ? `artifact:${artifactAfterHash}`
    : artifactAfterHash;
  return {
    ...support,
    artifactAfterHash: selectedArtifactAfterHash,
    artifact_after_hash: selectedArtifactAfterHash,
  };
}

function validationProfileEvidenceFor({
  profileId,
  profileClass,
  evidenceRefs,
  proofIds,
  source = 'agent_split_run_mode_visual_ledger_recomputed',
}) {
  return {
    schemaVersion: 'synthi.gpu.hmr.validation_profile_evidence.v1',
    accepted: true,
    profileId,
    profileClass,
    source,
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
assert.match(flowRunModeCoverageSupport.artifactAfterHash, /^artifact:sha256:[a-f0-9]{64}$/);
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
    editHash: hashValue('cold-split'),
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
    editHash: hashValue('source-edit:hot1'),
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
    editHash: hashValue('source-edit:hot2'),
    editKind: 'different_gpu_edit',
    differentEdit: true,
  },
});

await writeJson(path.join(visualDir, 'run-mode-forged-readable-no-hash-diff.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:forged-readable-no-hash-diff',
    'gpu-runtime-proof:sha256:forged-readable-no-hash-diff',
  ),
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-readable-no-hash-diff',
  }),
  targetId: 'forged-readable-no-hash-diff',
  profileId: 'forged-readable-no-hash-diff',
  proofId: 'agent-split-run-mode-proof:sha256:forged-readable-no-hash-diff',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(visualDir, 'before-hmr-first.png'),
    afterImage: path.join(visualDir, 'after-hmr-first.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:forged-readable-no-hash-diff',
    editHash: hashValue('forged-readable-no-hash-diff'),
    editKind: 'gpu_artifact_edit',
  },
});

const webgpuSingleFrameColdDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-webgpu-single-frame-cold');
await writeRgbaPng(path.join(webgpuSingleFrameColdDir, 'initial-frame.png'), 8, 8, (x, y) =>
  x >= y ? [20 + x, 64 + y, 180, 255] : [0, 0, 0, 255]);
await writeJson(path.join(webgpuSingleFrameColdDir, 'run-mode-cold-single-frame.json'), {
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  backend: 'webgpu',
  targetId: 'webgpu-single-frame-cold',
  profileId: 'webgpu-single-frame-cold',
  proofId: 'agent-split-run-mode-proof:sha256:webgpu-single-frame-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  visualArtifacts: {
    beforeImage: path.join(webgpuSingleFrameColdDir, 'initial-frame.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-webgpu-frame',
    editHash: hashValue('webgpu-single-frame-cold'),
  },
});
await writeJson(path.join(webgpuSingleFrameColdDir, 'run-mode-hot-single-frame-forged.json'), {
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  backend: 'webgpu',
  targetId: 'webgpu-single-frame-hot-forged',
  profileId: 'webgpu-single-frame-hot-forged',
  proofId: 'agent-split-run-mode-proof:sha256:webgpu-single-frame-hot-forged',
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:webgpu-single-frame-hot-forged',
    'gpu-runtime-proof:sha256:webgpu-single-frame-hot-forged',
  ),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  visualArtifacts: {
    beforeImage: path.join(webgpuSingleFrameColdDir, 'initial-frame.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:webgpu-single-frame-hot-forged',
    editHash: hashValue('webgpu-single-frame-hot-forged'),
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

const forgedGenericOpenclDir = path.join(artifactsRoot, 'strict-runtime-ledger', 'forged-generic-opencl');
const forgedGenericOpenclReadback = path.join(forgedGenericOpenclDir, 'readback.bin');
const forgedGenericOpenclBytes = Buffer.from([2, 4, 8, 16, 32, 64, 128, 255]);
await fs.mkdir(forgedGenericOpenclDir, { recursive: true });
await fs.writeFile(forgedGenericOpenclReadback, forgedGenericOpenclBytes);
await writeJson(`${forgedGenericOpenclReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  dtype: 'uint8',
  byteLength: forgedGenericOpenclBytes.length,
  shape: [forgedGenericOpenclBytes.length],
});
await writeRgbaPng(`${forgedGenericOpenclReadback}.card.png`, 8, 8, (x, y) => {
  const value = forgedGenericOpenclBytes[(x + y) % forgedGenericOpenclBytes.length];
  return [value, 255 - value, (value * 3) % 256, 255];
});
const forgedGenericOpenclMaterials = computeProofLedgerMaterials('forged-generic-opencl-label', {
  projectId: 'forged-generic-opencl-label',
  backend: 'opencl',
  rawReadbackPath: forgedGenericOpenclReadback,
  rawReadbackBytes: forgedGenericOpenclBytes,
});
const forgedGenericOpenclContract = acceptanceContract('forged_generic_opencl_label', {
  projectId: 'forged-generic-opencl-label',
});
forgedGenericOpenclContract.backend = { value: 'opencl' };
forgedGenericOpenclContract.artifact_identity.artifact_kind = 'opencl_program';
forgedGenericOpenclContract.opencl_contract = {
  program_hash_before: forgedGenericOpenclContract.artifact_hash_before,
  program_hash_after: forgedGenericOpenclContract.artifact_hash_after,
  kernel_name: 'flow_kernel',
  command_queue: 'queue:0',
  work_dim: 1,
  global_work_size: [64],
  local_work_size: [64],
  event_trace: 'event:forged-generic-opencl-label',
  output_buffer_readback: 'buffer:flow-output',
  field_evidence_refs: Object.fromEntries([
    'program_hash_before',
    'program_hash_after',
    'kernel_name',
    'command_queue',
    'work_dim',
    'global_work_size',
    'local_work_size',
    'event_trace',
    'output_buffer_readback',
  ].map((field) => [field, ['evidence:synthetic-runtime:forged-generic-opencl-label']])),
};
forgedGenericOpenclMaterials.proofLedger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.proof_ledger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtimeProofArtifact.proof_ledger =
  forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedger;
forgedGenericOpenclMaterials.runtime_proof_artifact.proof_ledger =
  forgedGenericOpenclMaterials.runtime_proof_artifact.proofLedger;
forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtimeProofArtifact.proof_ledger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContract = forgedGenericOpenclContract;
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptance_contract = forgedGenericOpenclContract;
forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedgerQuery =
  queryGpuHmrLedgerInvariants(forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedger);
forgedGenericOpenclMaterials.runtimeProofArtifact.proof_ledger_query =
  forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedgerQuery;
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractEvaluation =
  evaluateGpuHmrAcceptanceContract(forgedGenericOpenclContract);
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptance_contract_evaluation =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractEvaluation;
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractConsistency =
  evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: forgedGenericOpenclContract,
    derivedContract: forgedGenericOpenclContract,
  });
forgedGenericOpenclMaterials.runtimeProofArtifact.acceptance_contract_consistency =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractConsistency;
forgedGenericOpenclMaterials.runtime_proof_artifact.proofLedger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtime_proof_artifact.proof_ledger.records[0].backend = 'opencl';
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptanceContract = forgedGenericOpenclContract;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptance_contract = forgedGenericOpenclContract;
forgedGenericOpenclMaterials.runtime_proof_artifact.proofLedgerQuery =
  forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedgerQuery;
forgedGenericOpenclMaterials.runtime_proof_artifact.proof_ledger_query =
  forgedGenericOpenclMaterials.runtimeProofArtifact.proofLedgerQuery;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptanceContractEvaluation =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractEvaluation;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptance_contract_evaluation =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractEvaluation;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptanceContractConsistency =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractConsistency;
forgedGenericOpenclMaterials.runtime_proof_artifact.acceptance_contract_consistency =
  forgedGenericOpenclMaterials.runtimeProofArtifact.acceptanceContractConsistency;
await writeJson(path.join(forgedGenericOpenclDir, 'forged-generic-opencl-label.json'), {
  schemaVersion: 'synthi.gpu.hmr.proof.v1',
  proofId: 'gpu-runtime-proof:sha256:forged-generic-opencl-label',
  target_name: 'forged-generic-opencl-label',
  gpuHmrSuccess: true,
  fullRuntimeProven: true,
  resultState: 'gpu-hmr-full-runtime-proven',
  acceptanceContract: forgedGenericOpenclContract,
  proofLedger: forgedGenericOpenclMaterials.proofLedger,
  proof_ledger: forgedGenericOpenclMaterials.proof_ledger,
  proofLedgerQuery: forgedGenericOpenclMaterials.proofLedgerQuery,
  proof_ledger_query: forgedGenericOpenclMaterials.proof_ledger_query,
  runtimeProofArtifact: forgedGenericOpenclMaterials.runtimeProofArtifact,
  runtime_proof_artifact: forgedGenericOpenclMaterials.runtime_proof_artifact,
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
    editHash: hashValue('forged-source-adapted-webgpu'),
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
    editHash: hashValue('forged-top-level-source-adapted-webgpu'),
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
    editHash: `sha256:${'9'.repeat(64)}`,
    editKind: 'negative_edit',
    differentEdit: true,
  },
  executableStaticCheck: {
    accepted: true,
    signatureChanged: true,
    negativeKernelFound: true,
    sourceAfterHash: `sha256:${'8'.repeat(64)}`,
    acceptedSignatureHash: `sha256:${'7'.repeat(64)}`,
    negativeSignatureHash: `sha256:${'6'.repeat(64)}`,
  },
  reasons: ['abi_compatibility_class_layout_changed', 'gpu_hmr_rejected_before_load'],
});

await writeJson(path.join(visualDir, 'negative-edit-refusal-forged-reasons-only.json'), {
  schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
  proofId: 'agent-split-negative-edit-refusal:sha256:forged-reasons-only',
  backend: 'hip',
  targetId: 'forged-negative-reasons-only',
  profileId: 'forged-negative-reasons-only',
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'negative-edit:forged-reasons-only',
    editHash: `sha256:${'5'.repeat(64)}`,
    editKind: 'negative_edit',
    differentEdit: true,
  },
  reasons: ['gpu_hmr_rejected_before_load'],
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
    editHash: hashValue('forged-unlinked-flow-cold'),
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
    editHash: hashValue('stale-cold-only'),
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

const webGpuPreflightEvidenceRef = 'evidence:synthetic-webgpu-preflight:browser-runtime-capability';
await writeJson(path.join(artifactsRoot, 'webgpu-preflight', 'webgpu-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_preflight.v1',
  slug: 'synthetic-webgpu-preflight',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'webgpu',
      evidenceRefs: [webGpuPreflightEvidenceRef],
    },
    backendFamily: {
      value: 'webgpu',
      evidenceRefs: [webGpuPreflightEvidenceRef],
    },
    runtimeCapabilityPreflight: {
      backend: 'webgpu',
      backendFamily: 'webgpu',
      probe: 'webgpu_browser_runtime_preflight',
      browserLaunched: true,
      secureContext: true,
      navigatorGpuPresent: true,
      adapterFound: true,
      deviceCreated: true,
      renderSubmitted: true,
      noShimApplied: true,
      noBrowserFlagClaimedAsHmr: true,
      noSynthesizedRuntime: true,
      noSymlinkApplied: true,
      evidenceRefs: [webGpuPreflightEvidenceRef],
    },
    evidenceRefs: [webGpuPreflightEvidenceRef],
  },
  classification: {
    webgpuAccepted: true,
    resultState: 'webgpu-runtime-preflight-accepted',
    unsupportedReasons: [],
    diagnosticScreenshot: null,
  },
  acceptance: {
    acceptedForWebGpuRuntimePreflight: true,
    acceptedForWebGpuPipelineProof: false,
    gpuHmrSuccess: false,
    reason: 'preflight_only_shader_module_pipeline_and_frame_oracle_still_required',
    noShimApplied: true,
    noBrowserFlagClaimedAsHmr: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'webgpu-preflight-proof:sha256:synthetic',
});

const oidnHipPreflightEvidenceRef = 'evidence:synthetic-oidn-hip-preflight:runtime-capability';
await writeJson(path.join(artifactsRoot, 'oidn-hip-preflight', 'oidn-hip-proof.json'), {
  schema: 'synthi.gpu_hmr.oidn_preflight.v1',
  slug: 'synthetic-oidn-hip-preflight',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: {
      value: 'oidn_hip',
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    backendFamily: {
      value: 'oidn_hip',
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    runtimeCapabilityPreflight: {
      backend: 'oidn_hip',
      backendFamily: 'oidn_hip',
      probe: 'oidn_hip_device_preflight',
      toolFound: true,
      hipDeviceLibraryFound: true,
      hipTestCount: 2,
      cpuDiagnosticCount: 2,
      noShimApplied: true,
      noSymlinkApplied: true,
      noSynthesizedRuntime: true,
      evidenceRefs: [oidnHipPreflightEvidenceRef],
    },
    evidenceRefs: [oidnHipPreflightEvidenceRef],
  },
  classification: {
    oidnHipRuntimePreflightAccepted: true,
    oidnHipOutputProofAccepted: false,
    oidnHipOutputOracleProven: false,
    resultState: 'oidn-hip-runtime-preflight-accepted',
    unsupportedReasons: [],
    outputProofGaps: ['oidn_output_oracle_not_proven'],
    openGaps: ['oidn_output_oracle_not_proven'],
  },
  acceptance: {
    acceptedForOidnHipRuntimePreflight: true,
    acceptedForHipOutputProof: false,
    acceptedForOidnHipOutputProof: false,
    outputOracleProven: false,
    gpuHmrSuccess: false,
    reason: 'preflight_only_oidn_output_oracle_still_required',
    openGaps: ['oidn_output_oracle_not_proven'],
    noShimApplied: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'oidn-preflight-proof:sha256:synthetic',
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

const forgedRawBackendPreflightDir = path.join(artifactsRoot, 'forged-raw-backend-preflight');
await writeJson(path.join(forgedRawBackendPreflightDir, 'raw-vulkan-backend-refs.json'), {
  schema: 'synthi.gpu_hmr.vulkan_preflight.v1',
  slug: 'forged-raw-vulkan-backend-refs',
  backend: 'vulkan',
  backendFamily: 'vulkan',
  evidenceRefs: ['evidence:forged-raw-vulkan-preflight'],
  classification: {
    backend: 'vulkan',
    backendFamily: 'vulkan',
    vulkanAccepted: true,
    resultState: 'vulkan-runtime-observed',
    unsupportedReasons: [],
    evidenceRefs: ['evidence:forged-raw-vulkan-preflight'],
  },
  acceptance: {
    acceptedForVulkanRuntimePreflight: true,
    acceptedForVulkanPipelineProof: false,
    gpuHmrSuccess: false,
    noShimApplied: true,
    noIcdSynthesized: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'vulkan-preflight-proof:sha256:forged-raw-backend-refs',
});

const schemaCorrectRawBackendPreflightDir = path.join(artifactsRoot, 'schema-correct-raw-backend-preflight');
await writeJson(path.join(schemaCorrectRawBackendPreflightDir, 'schema-correct-raw-vulkan-backend.json'), {
  schema: 'synthi.gpu_hmr.vulkan_preflight.v1',
  slug: 'schema-correct-raw-vulkan-backend',
  backendEvidence: {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_contract.v1',
    backend: 'vulkan',
    backendFamily: 'vulkan',
    runtimeCapabilityPreflight: {
      probe: 'vulkan_loader_preflight',
      evidenceRefs: ['evidence:schema-correct-raw-vulkan-preflight'],
    },
    evidenceRefs: ['evidence:schema-correct-raw-vulkan-preflight'],
  },
  acceptance: {
    acceptedForVulkanRuntimePreflight: true,
    acceptedForVulkanPipelineProof: false,
    gpuHmrSuccess: false,
    noShimApplied: true,
    noIcdSynthesized: true,
    noSynthesizedRuntime: true,
    noSymlinkApplied: true,
  },
  proofId: 'vulkan-preflight-proof:sha256:schema-correct-raw-backend',
});

function externalProjectContractForTest({
  profileId,
  backend,
  backendFamily,
  libraryFamily,
  runtimeEnvironment,
  profileClass,
  manifestHash,
  runtimeEvidenceRefs,
}) {
  const evidenceRefs = [`test:external-contract:${profileId}`];
  const typed = (field, value) => ({
    value,
    evidenceRefs: [...evidenceRefs, `test:external-contract:${profileId}:${field}`],
  });
  return {
    schemaVersion: 'synthi.gpu_hmr.external_project_contract.v2',
    accepted: true,
    profileId,
    profile_id: profileId,
    backend: typed('backend', backend),
    backendFamily: typed('backendFamily', backendFamily),
    backend_family: typed('backendFamily', backendFamily),
    libraryFamily: typed('libraryFamily', libraryFamily),
    library_family: typed('libraryFamily', libraryFamily),
    runtimeEnvironment: typed('runtimeEnvironment', runtimeEnvironment),
    runtime_environment: typed('runtimeEnvironment', runtimeEnvironment),
    profileClass: typed('profileClass', profileClass),
    profile_class: typed('profileClass', profileClass),
    profileManifestHash: manifestHash,
    profile_manifest_hash: manifestHash,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    runtimeEvidence: {
      evidenceRefs: runtimeEvidenceRefs,
      evidence_refs: runtimeEvidenceRefs,
    },
    runtime_evidence: {
      evidenceRefs: runtimeEvidenceRefs,
      evidence_refs: runtimeEvidenceRefs,
    },
    arbitraryLibraryAccepted: false,
    arbitrary_library_accepted: false,
    arbitraryTargetRuntimeAccepted: false,
    arbitrary_target_runtime_accepted: false,
  };
}

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
  externalProjectContract: externalProjectContractForTest({
    profileId: 'explicit-bevy-wgsl-shader-material',
    backend: 'bevy_wgsl',
    backendFamily: 'wgpu_vulkan',
    libraryFamily: 'bevy',
    runtimeEnvironment: 'mcp_preview',
    profileClass: 'engine_asset_reload_visual_profile',
    manifestHash: hashValue('explicit-bevy-wgsl-shader-material-manifest'),
    runtimeEvidenceRefs: ['external-rejection-proof:sha256:synthetic-bevy'],
  }),
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
const externalVisualProjectContract = externalProjectContractForTest({
  profileId: 'explicit-external-engine-visual',
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  manifestHash: externalVisualProfileSelection.manifestHash,
  runtimeEvidenceRefs: ['external-visual-proof:explicit-external-engine-visual'],
});
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
  externalProjectContract: externalVisualProjectContract,
  external_project_contract: externalVisualProjectContract,
  profileSelection: externalVisualProfileSelection,
  profile_selection: externalVisualProfileSelection,
  sourceDeltaEvidence: externalVisualSourceDeltaEvidence,
  source_delta_evidence: externalVisualSourceDeltaEvidence,
  visualOracleArtifacts: visualArtifactSet({
    before: externalVisualBefore,
    after: externalVisualAfter,
    diff: externalVisualDiff,
  }, {
    capture_backend: 'external_runtime_screenshot',
  }),
  visualDiff: {
    changedPixelRatio: 0.5,
    meanAbsDelta8bit: 24,
    visiblePixelCount: 76800,
  },
  deterministicVisualMode: deterministicMode('explicit-external-engine-visual'),
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
  externalProjectContract: externalVisualProjectContract,
  external_project_contract: externalVisualProjectContract,
  status: 'pass',
  profileSelection: externalVisualProfileSelection,
  profile_selection: externalVisualProfileSelection,
  sourceDeltaEvidence: externalVisualSourceDeltaEvidence,
  source_delta_evidence: externalVisualSourceDeltaEvidence,
  visualOracleArtifacts: visualArtifactSet({
    before: externalVisualBefore,
    after: externalVisualAfter,
    diff: externalVisualDiff,
  }, {
    capture_backend: 'external_runtime_screenshot',
  }),
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

const seedlessExternalVisualProfileId = 'forged-external-engine-seedless-visual';
const seedlessExternalVisualProfileSelection = {
  ...externalVisualProfileSelection,
  profileId: seedlessExternalVisualProfileId,
  profile_id: seedlessExternalVisualProfileId,
  manifestHash: hashValue(`${seedlessExternalVisualProfileId}-manifest`),
  manifest_hash: hashValue(`${seedlessExternalVisualProfileId}-manifest`),
  path: `profiles/${seedlessExternalVisualProfileId}.json`,
  evidenceRefs: [`test:external-profile-selection:${seedlessExternalVisualProfileId}`],
  evidence_refs: [`test:external-profile-selection:${seedlessExternalVisualProfileId}`],
};
const seedlessExternalVisualSourceDeltaEvidence = {
  ...externalVisualSourceDeltaEvidence,
  beforeFileHash: hashValue(`${seedlessExternalVisualProfileId}-before-file`),
  before_file_hash: hashValue(`${seedlessExternalVisualProfileId}-before-file`),
  afterFileHash: hashValue(`${seedlessExternalVisualProfileId}-after-file`),
  after_file_hash: hashValue(`${seedlessExternalVisualProfileId}-after-file`),
  evidenceRefs: [`source:src/material.frag:${seedlessExternalVisualProfileId}`],
  evidence_refs: [`source:src/material.frag:${seedlessExternalVisualProfileId}`],
};
const seedlessExternalVisualProjectContract = externalProjectContractForTest({
  profileId: seedlessExternalVisualProfileId,
  backend: 'webgl',
  backendFamily: 'webgl',
  libraryFamily: 'threejs',
  runtimeEnvironment: 'browser_dev_server',
  profileClass: 'external_engine_visual_profile',
  manifestHash: seedlessExternalVisualProfileSelection.manifestHash,
  runtimeEvidenceRefs: [`external-visual-proof:${seedlessExternalVisualProfileId}`],
});
const seedlessExternalVisualMode = {
  ...deterministicMode(seedlessExternalVisualProfileId),
  fixed_seed: false,
  seed_policy_fixed: false,
  seed_policy_hash: null,
};
const seedlessExternalVisualProofMaterial = {
  ...externalVisualProofMaterial,
  profileId: seedlessExternalVisualProfileId,
  externalProjectContract: seedlessExternalVisualProjectContract,
  external_project_contract: seedlessExternalVisualProjectContract,
  profileSelection: seedlessExternalVisualProfileSelection,
  profile_selection: seedlessExternalVisualProfileSelection,
  sourceDeltaEvidence: seedlessExternalVisualSourceDeltaEvidence,
  source_delta_evidence: seedlessExternalVisualSourceDeltaEvidence,
  deterministicVisualMode: seedlessExternalVisualMode,
  deterministicVisualModeEvaluation: {
    accepted: true,
  },
};
const seedlessExternalVisualProofArtifact = {
  ...seedlessExternalVisualProofMaterial,
  proofId: `external-visual-proof:${sha256Hex(stableJson(seedlessExternalVisualProofMaterial))}`,
};
const seedlessExternalVisualProofArtifactPath = path.join(
  logsRoot,
  'external-projects',
  'forged-external-engine-seedless-visual-proof.json',
);
await writeJson(seedlessExternalVisualProofArtifactPath, seedlessExternalVisualProofArtifact);
await writeJson(path.join(logsRoot, 'external-projects', 'forged-external-engine-seedless-visual-report.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_profile.report.v1',
  profile: {
    id: seedlessExternalVisualProfileId,
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
  externalProjectContract: seedlessExternalVisualProjectContract,
  external_project_contract: seedlessExternalVisualProjectContract,
  status: 'pass',
  profileSelection: seedlessExternalVisualProfileSelection,
  profile_selection: seedlessExternalVisualProfileSelection,
  sourceDeltaEvidence: seedlessExternalVisualSourceDeltaEvidence,
  source_delta_evidence: seedlessExternalVisualSourceDeltaEvidence,
  visualOracleArtifacts: visualArtifactSet({
    before: externalVisualBefore,
    after: externalVisualAfter,
    diff: externalVisualDiff,
  }, {
    capture_backend: 'external_runtime_screenshot',
  }),
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
    proofId: seedlessExternalVisualProofArtifact.proofId,
    path: seedlessExternalVisualProofArtifactPath,
    visualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
    acceptedVisualEvidenceArtifactCount: externalVisualEvidenceArtifacts.length,
    contentHashes: externalVisualEvidenceArtifacts.map((artifact) => artifact.contentHash),
  },
  proofArtifactPaths: [seedlessExternalVisualProofArtifactPath],
  timings: {
    totalMs: 44,
    editToScreenshotMs: 12,
    visualDiffMs: 3,
  },
  proofId: 'external-profile-report:sha256:forged-seedless-engine-visual',
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
  observed: true,
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
  evidenceRefs: [`evidence:runtime-capability-preflight:${hashValue('accepted-runtime-capability-preflight')}`],
};

const acceptedSidecarRuntimeConsistencyNotApplicable = {
  schemaVersion: 'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1',
  status: 'not_applicable',
  accepted: true,
  notApplicable: true,
  not_applicable: true,
  proofAuthority: 'explicit_no_device_sidecar_in_target_contract',
  proof_authority: 'explicit_no_device_sidecar_in_target_contract',
  blockingGaps: [],
  blocking_gaps: [],
  evidenceRefs: [`evidence:sidecar-runtime-consistency:${hashValue('sidecar-not-applicable')}`],
  evidence_refs: [`evidence:sidecar-runtime-consistency:${hashValue('sidecar-not-applicable')}`],
};

function acceptedRealRocmDeviceSidecarContract(scope, overrides = {}) {
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_device_sidecar_contract_facet.v1',
    declared: overrides.declared ?? false,
    required: overrides.required ?? false,
    status: 'device_sidecar_runtime_proof_evidence',
    proofAuthority: 'runtime_observed_sidecar_contract_evidence',
    proof_authority: 'runtime_observed_sidecar_contract_evidence',
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: true,
    runtime_observation_complete: true,
    runtimeObservedByStage: {
      artifactTransport: true,
      epochPublication: true,
      dispatchTrace: true,
      outputOracle: true,
      hostIdentity: true,
    },
    runtime_observed_by_stage: {
      artifactTransport: true,
      epochPublication: true,
      dispatchTrace: true,
      outputOracle: true,
      hostIdentity: true,
    },
    sourceCoverageComplete: true,
    source_coverage_complete: true,
    backend: overrides.backend ?? 'hip',
    artifact_identity: {
      source_paths: [`src/${scope}/kernel.hip`],
      artifact_kind: 'hsaco',
      entry_points: [`kernel_${scope}`],
      compile_target: 'gfx1201',
      compiler: '/opt/rocm/llvm/bin/amdclang++',
      compiler_args_hash: hashValue(`sidecar-compile-args:${scope}`),
    },
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [
      `evidence:sidecar-contract:${scope}`,
      `gpu-runtime-proof:sha256:${sha256Hex(`sidecar-runtime:${scope}`)}`,
    ],
    evidence_refs: [
      `evidence:sidecar-contract:${scope}`,
      `gpu-runtime-proof:sha256:${sha256Hex(`sidecar-runtime:${scope}`)}`,
    ],
    contractHash: hashValue(`sidecar-contract:${scope}`),
    contract_hash: hashValue(`sidecar-contract:${scope}`),
    ...overrides,
  };
}

function acceptedRealRocmSidecarRuntimeConsistency(scope, overrides = {}) {
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1',
    status: 'sidecar_runtime_consistency_proven',
    accepted: true,
    runtimeConsistencyAccepted: true,
    runtime_consistency_accepted: true,
    notApplicable: false,
    not_applicable: false,
    proofAuthority: 'sidecar_backend_runtime_consistency_evidence',
    proof_authority: 'sidecar_backend_runtime_consistency_evidence',
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
    sidecarBackend: overrides.sidecarBackend ?? overrides.sidecar_backend ?? 'hip',
    sidecar_backend: overrides.sidecar_backend ?? overrides.sidecarBackend ?? 'hip',
    runtimeBackendCandidates: overrides.runtimeBackendCandidates ?? ['hip'],
    runtime_backend_candidates: overrides.runtime_backend_candidates ?? ['hip'],
    backendConsistent: overrides.backendConsistent ?? true,
    backend_consistent: overrides.backend_consistent ?? true,
    sidecarEvidenceComplete: true,
    sidecar_evidence_complete: true,
    sidecarRuntimeObservationComplete: true,
    sidecar_runtime_observation_complete: true,
    sidecarCanSatisfyRuntimeProof: true,
    sidecar_can_satisfy_runtime_proof: true,
    runtimeObserved: true,
    runtime_observed: true,
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [`evidence:sidecar-runtime-consistency:${scope}`],
    evidence_refs: [`evidence:sidecar-runtime-consistency:${scope}`],
    contractHash: hashValue(`sidecar-runtime-consistency:${scope}`),
    contract_hash: hashValue(`sidecar-runtime-consistency:${scope}`),
    ...overrides,
  };
}

function acceptedRealRocmAppHookContract(scope, overrides = {}) {
  const stageNames = [
    'artifact_transport',
    'epoch_publication',
    'dispatch_trace',
    'host_identity',
    'output_oracle',
  ];
  const stageResults = Object.fromEntries(stageNames.flatMap((stage) => {
    const result = {
      stage,
      declared: true,
      required: true,
      contractEvidencePresent: true,
      contract_evidence_present: true,
      runtimeObserved: true,
      runtime_observed: true,
      evidenceRefs: [`evidence:app-hook:${scope}:${stage}`],
      evidence_refs: [`evidence:app-hook:${scope}:${stage}`],
      unresolvedEvidenceRefs: [],
      unresolved_evidence_refs: [],
      status: 'contract_and_runtime_observed',
    };
    const camel = stage.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    return [[stage, result], [camel, result]];
  }));
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_app_hook_contract_facet.v1',
    declared: true,
    required: true,
    status: 'supplemental_app_hook_runtime_proof_evidence',
    proofAuthority: 'evidence_only_not_gpu_hmr_success',
    proof_authority: 'evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
    nativeLaunchBoundaryObserved: true,
    native_launch_boundary_observed: true,
    contractEvidenceComplete: true,
    contract_evidence_complete: true,
    runtimeObservationComplete: true,
    runtime_observation_complete: true,
    stageResults,
    stage_results: stageResults,
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: stageNames.map((stage) => `evidence:app-hook:${scope}:${stage}`),
    evidence_refs: stageNames.map((stage) => `evidence:app-hook:${scope}:${stage}`),
    contractHash: hashValue(`app-hook-contract:${scope}`),
    contract_hash: hashValue(`app-hook-contract:${scope}`),
    ...overrides,
  };
}

function acceptedSameProcessRuntimeOracle(scope, overrides = {}) {
  const closureRefs = [
    `runtime-proof-artifact:sha256:${sha256Hex(`compute:${scope}`)}`,
    hashValue(`compute-artifact-after:${scope}`),
    `epoch:${scope}`,
    `dispatch:${scope}`,
    `output-target:${scope}`,
  ];
  return {
    schemaVersion: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v1',
    schema_version: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v1',
    declared: true,
    required: true,
    status: 'same_process_runtime_oracle_contract_proven',
    proofAuthority: 'runtime_stage_evidence_not_serialized_claim',
    proof_authority: 'runtime_stage_evidence_not_serialized_claim',
    accepted: true,
    canSatisfyRuntimeProof: true,
    can_satisfy_runtime_proof: true,
    canSatisfyDispatchProof: true,
    can_satisfy_dispatch_proof: true,
    appHookContractAccepted: true,
    app_hook_contract_accepted: true,
    artifactTransportObserved: true,
    artifact_transport_observed: true,
    epochPublicationObserved: true,
    epoch_publication_observed: true,
    dispatchTraceObserved: true,
    dispatch_trace_observed: true,
    dispatchUsedPublishedEpoch: true,
    dispatch_used_published_epoch: true,
    sameProcessIdentityObserved: true,
    same_process_identity_observed: true,
    outputOracleObserved: true,
    output_oracle_observed: true,
    outputTargetObserved: true,
    output_target_observed: true,
    outputTargetMatched: true,
    output_target_matched: true,
    outputAfterDispatchObserved: true,
    output_after_dispatch_observed: true,
    artifactEpochMatched: true,
    artifact_epoch_matched: true,
    firewallAccepted: true,
    firewall_accepted: true,
    cpuHmrUsed: false,
    cpu_hmr_used: false,
    fullRebuildUsed: false,
    full_rebuild_used: false,
    processRestarted: false,
    process_restarted: false,
    stageResults: {
      artifact_transport: { observed: true },
      epoch_publication: { observed: true },
      dispatch_trace: {
        observed: true,
        dispatchUsedPublishedEpoch: true,
        dispatch_used_published_epoch: true,
      },
      host_identity: {
        observed: true,
        sameProcessIdentityObserved: true,
        same_process_identity_observed: true,
      },
      output_oracle: {
        observed: true,
        outputTargetObserved: true,
        output_target_observed: true,
        outputTargetMatched: true,
        output_target_matched: true,
        outputAfterDispatchObserved: true,
        output_after_dispatch_observed: true,
        dispatchOutputTarget: `output-target:${scope}`,
        dispatch_output_target: `output-target:${scope}`,
        oracleOutputTarget: `output-target:${scope}`,
        oracle_output_target: `output-target:${scope}`,
      },
    },
    stage_results: {
      artifact_transport: { observed: true },
      epoch_publication: { observed: true },
      dispatch_trace: {
        observed: true,
        dispatchUsedPublishedEpoch: true,
        dispatch_used_published_epoch: true,
      },
      host_identity: {
        observed: true,
        sameProcessIdentityObserved: true,
        same_process_identity_observed: true,
      },
      output_oracle: {
        observed: true,
        outputTargetObserved: true,
        output_target_observed: true,
        outputTargetMatched: true,
        output_target_matched: true,
        outputAfterDispatchObserved: true,
        output_after_dispatch_observed: true,
        dispatchOutputTarget: `output-target:${scope}`,
        dispatch_output_target: `output-target:${scope}`,
        oracleOutputTarget: `output-target:${scope}`,
        oracle_output_target: `output-target:${scope}`,
      },
    },
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [`evidence:same-process-runtime-oracle:${scope}`, ...closureRefs],
    evidence_refs: [`evidence:same-process-runtime-oracle:${scope}`, ...closureRefs],
    contractHash: hashValue(`same-process-runtime-oracle:${scope}`),
    contract_hash: hashValue(`same-process-runtime-oracle:${scope}`),
    ...overrides,
  };
}

function acceptedLargeRocmSourceDeltaExecution(scope) {
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_execution.v1',
    phases: [
      ['hot_delta_1', 'real_repo_user_source_delta_hmr'],
      ['hot_delta_2', 'real_repo_second_user_source_delta_hmr'],
      ['negative_edit', 'real_repo_negative-edit_user_source_delta_hmr'],
    ].map(([kind, phaseName], index) => ({
      label: `${kind}:${scope}`,
      phaseName,
      phase_name: phaseName,
      phaseKind: kind,
      phase_kind: kind,
      metricScope: kind,
      metric_scope: kind,
      file: `src/${scope}/kernel_${index}.hip`,
      editHash: hashValue(`${scope}:${kind}:edit`),
      edit_hash: hashValue(`${scope}:${kind}:edit`),
      sourceBeforeHash: hashValue(`${scope}:${kind}:before`),
      source_before_hash: hashValue(`${scope}:${kind}:before`),
      sourceAfterHash: hashValue(`${scope}:${kind}:after`),
      source_after_hash: hashValue(`${scope}:${kind}:after`),
      sourceWriteObserved: true,
      source_write_observed: true,
      compileCallAttempted: true,
      compile_call_attempted: true,
      compileCallCompleted: kind !== 'negative_edit',
      compile_call_completed: kind !== 'negative_edit',
      expectedRefusal: kind === 'negative_edit',
      expected_refusal: kind === 'negative_edit',
    })),
  };
}

function acceptedLargeRocmProfileObligations(scope) {
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations_facet.v1',
    status: 'profile_proof_obligations_met',
    proofAuthority: 'profile_configuration_gate_not_runtime_proof',
    proof_authority: 'profile_configuration_gate_not_runtime_proof',
    declared: true,
    targetClass: 'large_rocm_ml_infrastructure',
    target_class: 'large_rocm_ml_infrastructure',
    finalAcceptance: true,
    final_acceptance: true,
    largeMlFinalAcceptance: true,
    large_ml_final_acceptance: true,
    requiresFullRuntimeProof: true,
    requires_full_runtime_proof: true,
    requiresOutputOracle: true,
    requires_output_oracle: true,
    outputOraclePresent: true,
    output_oracle_present: true,
    requiresRunModes: true,
    requires_run_modes: true,
    requiresRunModesDeclared: true,
    requires_run_modes_declared: true,
    requiresNegativeEdit: true,
    requires_negative_edit: true,
    requiresNegativeEditDeclared: true,
    requires_negative_edit_declared: true,
    hotDelta2FixtureDeclared: true,
    hot_delta_2_fixture_declared: true,
    negativeEditFixtureDeclared: true,
    negative_edit_fixture_declared: true,
    sourceDeltaExecutionAccepted: true,
    source_delta_execution_accepted: true,
    appHookContractDeclared: true,
    app_hook_contract_declared: true,
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [`evidence:large-rocm-profile-obligations:${scope}`],
    evidence_refs: [`evidence:large-rocm-profile-obligations:${scope}`],
  };
}

function largeRocmMlProfile(scope) {
  return {
    id: scope,
    targetClass: 'large_rocm_ml_infrastructure',
    target_class: 'large_rocm_ml_infrastructure',
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      target_class: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requires_full_runtime_proof: true,
      requiresOutputOracle: true,
      requires_output_oracle: true,
      requiresAppHookContract: true,
      requires_app_hook_contract: true,
      requiresRunModes: true,
      requires_run_modes: true,
      requiresNegativeEdit: true,
      requires_negative_edit: true,
    },
    proof_obligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      target_class: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requires_full_runtime_proof: true,
      requiresOutputOracle: true,
      requires_output_oracle: true,
      requiresAppHookContract: true,
      requires_app_hook_contract: true,
      requiresRunModes: true,
      requires_run_modes: true,
      requiresNegativeEdit: true,
      requires_negative_edit: true,
    },
    sourceDelta: {
      second: {
        file: `src/${scope}/kernel_hot2.hip`,
        before: 'return x + y;',
        after: 'return x + y + 1;',
      },
      extraDeltas: [{
        kind: 'negative_edit',
        file: `src/${scope}/kernel_negative.hip`,
        before: 'kernel(a, b, c);',
        after: 'kernel(a, c, b);',
        expectedRefusal: true,
      }],
    },
    source_delta: {
      second: {
        file: `src/${scope}/kernel_hot2.hip`,
        before: 'return x + y;',
        after: 'return x + y + 1;',
      },
      extra_deltas: [{
        kind: 'negative_edit',
        file: `src/${scope}/kernel_negative.hip`,
        before: 'kernel(a, b, c);',
        after: 'kernel(a, c, b);',
        expected_refusal: true,
      }],
    },
  };
}

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
      realRocmSidecarRuntimeConsistency: acceptedSidecarRuntimeConsistencyNotApplicable,
      real_rocm_sidecar_runtime_consistency: acceptedSidecarRuntimeConsistencyNotApplicable,
    },
    runtime_proof_artifact: {
      ...snakeRuntimeProofArtifact,
      runtimeCapabilityPreflight: acceptedRuntimeCapabilityPreflight,
      runtime_capability_preflight: acceptedRuntimeCapabilityPreflight,
      realRocmSidecarRuntimeConsistency: acceptedSidecarRuntimeConsistencyNotApplicable,
      real_rocm_sidecar_runtime_consistency: acceptedSidecarRuntimeConsistencyNotApplicable,
    },
  };
}

function stripExpectedOutputVerified(value) {
  if (Array.isArray(value)) {
    value.forEach(stripExpectedOutputVerified);
    return value;
  }
  if (value && typeof value === 'object') {
    delete value.expected_output_verified;
    delete value.expectedOutputVerified;
    for (const nested of Object.values(value)) stripExpectedOutputVerified(nested);
  }
  return value;
}

function realRocmRuntimeProofMaterials(scope, options = {}) {
  return withAcceptedRuntimeCapabilityPreflight(runtimeProofMaterials(scope, options));
}

function realRocmRuntimeProofMaterialsWithSidecar(scope, options = {}) {
  const materials = realRocmRuntimeProofMaterials(scope, options);
  const deviceSidecar = acceptedRealRocmDeviceSidecarContract(scope, options.deviceSidecarOverrides);
  const sidecarRuntimeConsistency = acceptedRealRocmSidecarRuntimeConsistency(
    scope,
    options.sidecarRuntimeConsistencyOverrides,
  );
  return {
    ...materials,
    runtimeProofArtifact: {
      ...materials.runtimeProofArtifact,
      realRocmDeviceSidecarContract: deviceSidecar,
      real_rocm_device_sidecar_contract: deviceSidecar,
      deviceSidecarContract: deviceSidecar,
      device_sidecar_contract: deviceSidecar,
      realRocmSidecarRuntimeConsistency: sidecarRuntimeConsistency,
      real_rocm_sidecar_runtime_consistency: sidecarRuntimeConsistency,
      sidecarRuntimeConsistency,
      sidecar_runtime_consistency: sidecarRuntimeConsistency,
    },
    runtime_proof_artifact: {
      ...materials.runtime_proof_artifact,
      realRocmDeviceSidecarContract: deviceSidecar,
      real_rocm_device_sidecar_contract: deviceSidecar,
      deviceSidecarContract: deviceSidecar,
      device_sidecar_contract: deviceSidecar,
      realRocmSidecarRuntimeConsistency: sidecarRuntimeConsistency,
      real_rocm_sidecar_runtime_consistency: sidecarRuntimeConsistency,
      sidecarRuntimeConsistency,
      sidecar_runtime_consistency: sidecarRuntimeConsistency,
    },
  };
}

function realRocmComputeProofLedgerMaterials(scope, options = {}) {
  return withAcceptedRuntimeCapabilityPreflight(computeProofLedgerMaterials(scope, options));
}

function withNumericComputeEpoch(materials, epoch) {
  const numericEpoch = Number(epoch);
  assert.equal(Number.isInteger(numericEpoch) && numericEpoch >= 0, true);
  const copy = JSON.parse(JSON.stringify(materials));
  const replaceEpochFields = (value) => {
    if (Array.isArray(value)) {
      value.forEach(replaceEpochFields);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'epoch') value[key] = numericEpoch;
      else replaceEpochFields(child);
    }
  };
  replaceEpochFields(copy);
  const record = copy.proofLedger.records[0];
  for (const event of [
    record.epoch_publish_event,
    record.dispatch_event,
    record.output_event,
    record.retirement_event,
  ]) {
    if (event) event.epoch = numericEpoch;
  }
  if (record.output_event?.compute_oracle_artifacts) {
    record.output_event.compute_oracle_artifacts.epoch = numericEpoch;
  }
  if (record.oracle_artifacts?.compute_oracle_artifacts) {
    record.oracle_artifacts.compute_oracle_artifacts.epoch = numericEpoch;
  }
  if (copy.computeOracleArtifacts) copy.computeOracleArtifacts.epoch = numericEpoch;
  const proofLedger = buildGpuHmrProofLedger(record);
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  assert.deepEqual(proofLedgerQuery.failedInvariants, []);
  assert.equal(proofLedgerQuery.gpuHmrSuccess, true);
  copy.proofLedger = proofLedger;
  copy.proof_ledger = proofLedger;
  copy.proofLedgerQuery = proofLedgerQuery;
  copy.proof_ledger_query = proofLedgerQuery;
  for (const key of ['runtimeProofArtifact', 'runtime_proof_artifact']) {
    if (copy[key]) {
      copy[key].proofLedger = proofLedger;
      copy[key].proof_ledger = proofLedger;
      copy[key].proofLedgerQuery = proofLedgerQuery;
      copy[key].proof_ledger_query = proofLedgerQuery;
    }
  }
  return copy;
}

const largeRocmLatestReport = {
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
    targetClass: 'large_rocm_ml_infrastructure',
    target_class: 'large_rocm_ml_infrastructure',
    refusalOnly: false,
    refusal_only: false,
    progressionRequired: true,
    progression_required: true,
    finalAcceptance: true,
    final_acceptance: true,
    largeMlFinalAcceptance: true,
    large_ml_final_acceptance: true,
    requiresFullRuntimeProof: true,
    requires_full_runtime_proof: true,
    fullRuntimeProofRequested: true,
    full_runtime_proof_requested: true,
    requiresOutputOracle: true,
    requires_output_oracle: true,
    outputOraclePresent: false,
    output_oracle_present: false,
    requiresRunModes: true,
    requires_run_modes: true,
    requiresRunModesDeclared: false,
    requires_run_modes_declared: false,
    requiresNegativeEdit: true,
    requires_negative_edit: true,
    requiresNegativeEditDeclared: false,
    requires_negative_edit_declared: false,
    blockingGaps: [
      'proof_obligation_output_oracle_profile_missing',
      'proof_obligation_run_modes_missing',
      'proof_obligation_negative_edit_missing',
    ],
    blocking_gaps: [
      'proof_obligation_output_oracle_profile_missing',
      'proof_obligation_run_modes_missing',
      'proof_obligation_negative_edit_missing',
    ],
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
};
await writeJson(path.join(logsRoot, 'real-rocm-results.json'), largeRocmLatestReport);
const retainedRealRocmDir = path.join(logsRoot, 'real-rocm-results');
await writeJson(
  path.join(retainedRealRocmDir, 'gpu-real-rocm-large-lib-20260623.json'),
  largeRocmLatestReport,
);
await writeJson(path.join(retainedRealRocmDir, 'gpu-real-rocm-second-lib-20260623.json'), {
  ...largeRocmLatestReport,
  slug: 'gpu-real-rocm-second-lib-20260623',
  real_rocm_profile: {
    ...largeRocmLatestReport.real_rocm_profile,
    id: 'real-rocm-second-lib',
    source: 'scripts/profiles/real-rocm-second-lib.json',
  },
  source_url: 'https://example.invalid/rocm/second-lib.git',
  entry_file: 'src/kernels/second_entry.hip',
  delta_file: 'src/kernels/second_delta.h',
  target_name: 'SecondRocmDriver',
  timingMetrics: {
    ...largeRocmLatestReport.timingMetrics,
    editId: 'real-rocm-second-lib-delta',
    editHash: hashValue('real-rocm-second-lib-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/second-lib.git @ 0123456789ab files=8000' },
    ...largeRocmLatestReport.checks.slice(1),
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
await writeRgbaPng(path.join(forgedWebGpuVisualDir, 'forged-single-screenshot.png'), 8, 8, (x, y) => [
  16 + x,
  32 + y,
  64,
  255,
]);
await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-single-image-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:single-image-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-single-image' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
  },
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-single-image',
    visualRoot: forgedWebGpuVisualDir,
  }),
  visualOracleArtifacts: {
    diagnosticScreenshot: path.join(forgedWebGpuVisualDir, 'forged-single-screenshot.png'),
  },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});
await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-query-only-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:query-only-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-query-only' },
  visualOracleArtifacts: visualArtifactSet({
    before: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    after: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
    diff: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
  }),
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

await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-hash-mismatch-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:hash-mismatch-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-hash-mismatch' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
  },
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-hash-mismatch',
    visualRoot: forgedWebGpuVisualDir,
  }),
  visualOracleArtifacts: {
    beforeImage: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    beforeImageHash: hashValue('wrong-before-image-hash'),
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
});

const outsideVisualDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-outside-visual-'));
await writeRgbaPng(path.join(outsideVisualDir, 'outside-before.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(outsideVisualDir, 'outside-after.png'), 8, 8, (x, y) => [40 + x, 56 + y, 72, 255]);
await writeRgbaPng(path.join(outsideVisualDir, 'outside-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-path-escape-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:path-escape-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-path-escape' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
  },
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-path-escape',
    visualRoot: forgedWebGpuVisualDir,
  }),
  visualOracleArtifacts: {
    beforeImage: path.join(outsideVisualDir, 'outside-before.png'),
    afterImage: path.join(outsideVisualDir, 'outside-after.png'),
    diffImage: path.join(outsideVisualDir, 'outside-diff.png'),
  },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
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
  visualOracleArtifacts: visualArtifactSet({
    before: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    after: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
    diff: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
  }),
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

await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-seedless-visual-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:seedless-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-seedless-visual' },
  contract: {
    artifact_identity: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
    webgpu_contract: {
      supported_pipeline_scope: 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list',
    },
  },
  ...runtimeProofMaterials('hot_delta_1', {
    projectId: 'forged-webgpu-seedless-visual',
    visualRoot: forgedWebGpuVisualDir,
  }),
  deterministicVisualMode: {
    ...deterministicMode('hot_delta_1'),
    fixed_seed: false,
    seed_policy_fixed: false,
    seed_policy_hash: null,
  },
  deterministicVisualModeEvaluation: {
    accepted: true,
    forgedByFixture: true,
  },
  visualOracleArtifacts: visualArtifactSet({
    before: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    after: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
    diff: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
  }),
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
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
  visualArtifacts: visualArtifactSet({
    before: hiprtAcceptedBefore,
    after: hiprtAcceptedAfter,
    diff: hiprtAcceptedDiff,
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split',
    editHash: hashValue('accepted-hiprt-cold'),
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
  visualArtifacts: visualArtifactSet({
    before: hiprtAcceptedBefore,
    after: hiprtAcceptedAfter,
    diff: hiprtAcceptedDiff,
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:accepted-hiprt-hot2',
    editHash: hashValue('accepted-hiprt-hot2'),
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
  visualArtifacts: visualArtifactSet({
    before: hiprtAcceptedBefore,
    after: hiprtAcceptedAfter,
    diff: hiprtAcceptedDiff,
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:forged-hiprt-missing-instrumentation',
    editHash: hashValue('forged-hiprt-missing-instrumentation'),
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
    editHash: hashValue('truncated-visual-hot1'),
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
    editHash: hashValue('no-visual-optout-hot1'),
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

const backendMutatedAcceptedRow = JSON.parse(JSON.stringify(acceptedFlow));
backendMutatedAcceptedRow.backend = 'vulkan';
const backendMutatedAcceptedQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [backendMutatedAcceptedRow],
});
assert.equal(backendMutatedAcceptedQuery.accepted, false);
assert.equal(backendMutatedAcceptedQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(backendMutatedAcceptedQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_row_backend_bound_to_ledger_record'
));

const targetMutatedAcceptedRow = JSON.parse(JSON.stringify(acceptedFlow));
targetMutatedAcceptedRow.targetId = 'forged-target-with-stale-row-id';
const targetMutatedAcceptedQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [targetMutatedAcceptedRow],
});
assert.equal(targetMutatedAcceptedQuery.accepted, false);
assert.equal(targetMutatedAcceptedQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(targetMutatedAcceptedQuery.failedGates.some((gate) =>
  gate.code === 'validation_matrix_row_id_mismatch'
));

const nativeAuthorityTrace = {
  loaderEvents: [{
    source: 'hipModuleLoadData',
    evidenceRefs: ['evidence:native-authority:loader'],
  }],
  dispatchEvents: [{
    command: 'hipModuleLaunchKernel',
    evidenceRefs: ['evidence:native-authority:dispatch'],
  }],
  outputEvents: [{
    kind: 'visual_frame',
    evidenceRefs: ['evidence:native-authority:output'],
  }],
};
const nativeAuthorityRow = withQueryRecomputedRowId(acceptedAuthoritativeMatrixRow('native-authority-no-strict-artifact', {
  proofMode: 'hip_module_runtime_readback',
  proofChain: 'backend_native_recomputed_ledger_trace',
  proofChainAccepted: true,
  runtimeProofArtifact: null,
  runtime_proof_artifact: null,
  runtimeTrace: nativeAuthorityTrace,
  runtime_trace: nativeAuthorityTrace,
  fullRuntimeEvidenceAuthority: null,
  full_runtime_evidence_authority: null,
}));
const nativeAuthorityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [nativeAuthorityRow],
});
assert.equal(nativeAuthorityQuery.accepted, false);
assert.equal(nativeAuthorityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(nativeAuthorityQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_strict_runtime_proof_artifact'
));
assert.ok(nativeAuthorityQuery.failedGates.some((gate) =>
  gate.code === 'full_runtime_authority_strict_runtime_proof_artifact_missing'
));

const nativeAuthorityMissingLoaderRow = withQueryRecomputedRowId(acceptedAuthoritativeMatrixRow('native-authority-missing-loader', {
  proofMode: 'hip_module_runtime_readback',
  proofChain: 'backend_native_recomputed_ledger_trace',
  proofChainAccepted: true,
  runtimeProofArtifact: null,
  runtime_proof_artifact: null,
  runtimeTrace: {
    dispatchEvents: nativeAuthorityTrace.dispatchEvents,
    outputEvents: nativeAuthorityTrace.outputEvents,
  },
  runtime_trace: {
    dispatchEvents: nativeAuthorityTrace.dispatchEvents,
    outputEvents: nativeAuthorityTrace.outputEvents,
  },
  fullRuntimeEvidenceAuthority: null,
  full_runtime_evidence_authority: null,
}));
const nativeAuthorityMissingLoaderQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [nativeAuthorityMissingLoaderRow],
});
assert.equal(nativeAuthorityMissingLoaderQuery.accepted, false);
assert.equal(nativeAuthorityMissingLoaderQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(nativeAuthorityMissingLoaderQuery.failedGates.some((gate) =>
  gate.code === 'full_runtime_authority_native_runtime_trace_missing'
));
assert.ok(nativeAuthorityMissingLoaderQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_strict_runtime_proof_artifact'
));

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

const forgedGenericOpencl = ledger.rows.find((row) =>
  row.targetId === 'forged-generic-opencl-label'
);
assert.equal(forgedGenericOpencl?.proofMode, 'strict_runtime_ledger');
assert.equal(forgedGenericOpencl.backend, 'opencl');
assert.equal(forgedGenericOpencl.matrixOutcome, 'unproven');
assert.equal(forgedGenericOpencl.acceptedForGpuHmr, false);
assert.equal(forgedGenericOpencl.gpuHmrSuccess, false);
assert.equal(forgedGenericOpencl.outputOracleFacet.accepted, true);
assert.equal(forgedGenericOpencl.acceptanceScope, 'declared_profile_scoped');
assert.equal(forgedGenericOpencl.claimScope, 'unknown_scope');
assert.equal(forgedGenericOpencl.safety.accepted, true);
assert.ok(forgedGenericOpencl.reasons.includes('gpu_hmr_success_requires_known_acceptance_scope'));
assert.ok(forgedGenericOpencl.openGaps.includes('gpu_hmr_success_requires_known_acceptance_scope'));

function acceptedMatrixRowMissingFirewall(targetId, firewallFields = {}) {
  const artifactBeforeHash = hashValue(`accepted-row:${targetId}:artifact-before`);
  const artifactAfterHash = hashValue(`accepted-row:${targetId}:artifact-after`);
  const ledgerProofId = `gpu-ledger-proof:sha256:${sha256Hex(`accepted-row:${targetId}:ledger`)}`;
  const runtimeProofId = `gpu-runtime-proof:sha256:${sha256Hex(`accepted-row:${targetId}:runtime`)}`;
  const editHash = hashValue(`accepted-row:${targetId}:edit`);
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
    proofIds: [ledgerProofId, runtimeProofId],
    ledger: {
      present: true,
      source: 'recomputed_ledger',
      proofId: ledgerProofId,
      gpuHmrSuccess: true,
      failedInvariants: [],
      record: {
        proofId: ledgerProofId,
        proof_id: ledgerProofId,
        artifact_before_hash: artifactBeforeHash,
        artifact_after_hash: artifactAfterHash,
        loader_event: {
          artifact_hash: artifactAfterHash,
        },
        epoch_publish_event: {
          artifact_hash: artifactAfterHash,
        },
        dispatch_event: {
          artifact_hash: artifactAfterHash,
        },
        output_event: {
          artifact_hash: artifactAfterHash,
        },
      },
    },
    runtimeProofArtifact: {
      present: true,
      proofId: runtimeProofId,
      accepted: true,
      failedGates: [],
    },
    runMode: {
      editHash,
      edit_hash: editHash,
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
  const out = {
    ...row,
    targetId,
    profileId: targetId,
    ...fields,
  };
  delete out.matrixKey;
  delete out.attemptKey;
  delete out.row_id;
  const rowIdSeed = { ...out };
  delete rowIdSeed.rowId;
  delete rowIdSeed.row_id;
  delete rowIdSeed.matrixKey;
  delete rowIdSeed.matrix_key;
  delete rowIdSeed.attemptKey;
  delete rowIdSeed.attempt_key;
  out.rowId = `gpu-validation-matrix-row:sha256:${sha256Hex(stableJson(rowIdSeed))}`;
  return out;
}

function withQueryRecomputedRowId(row) {
  const probe = {
    ...JSON.parse(JSON.stringify(row)),
    rowId: 'gpu-validation-matrix-row:sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
  const query = queryGpuHmrValidationMatrixLedger({
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    rows: [probe],
  });
  const mismatch = query.failedGates.find((gate) => gate.code === 'validation_matrix_row_id_mismatch');
  assert.ok(mismatch?.recomputedRowId, 'expected query to expose recomputed row id for probe row');
  return {
    ...row,
    rowId: mismatch.recomputedRowId,
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
      ledger: {
        present: true,
        source: 'recomputed_ledger',
        gpuHmrSuccess: true,
        failedInvariants: [],
      },
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
const sourceDerivedOracleAdaptationQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-source-derived-oracle-adapted-row', {
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
      output_oracle_adaptations: [
        {
          kind: 'source_derived_buffer_checksum',
          profileId: 'hip.generic.readback.v1',
          oracleId: 'oracle:generic',
        },
      ],
    }),
  ],
});
assert.equal(sourceDerivedOracleAdaptationQuery.accepted, false);
assert.equal(sourceDerivedOracleAdaptationQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(sourceDerivedOracleAdaptationQuery.failedGates.some((gate) =>
  gate.code === 'source_adapted_profile_not_no_shim_gpu_hmr'
));
const missingNoShimSourceIdentityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-missing-no-shim-source-identity', {
      proofIds: [],
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
      runMode: {},
      noShimSourceIdentity: {
        schemaVersion: 'synthi.gpu_hmr.no_shim_source_identity.v1',
        accepted: true,
        proofIds: ['forged:no-shim-proof'],
      },
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(missingNoShimSourceIdentityQuery.accepted, false);
assert.equal(missingNoShimSourceIdentityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(missingNoShimSourceIdentityQuery.failedGates.some((gate) =>
  gate.code === 'no_shim_source_identity_source_or_edit_hash_missing'
));
assert.ok(missingNoShimSourceIdentityQuery.failedGates.some((gate) =>
  gate.code === 'no_shim_source_identity_runtime_artifact_chain_unclosed'
));
assert.ok(missingNoShimSourceIdentityQuery.failedGates.some((gate) =>
  gate.code === 'no_shim_source_identity_runtime_proof_binding_missing'
));
const sourcePathOnlyNoShimIdentityQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [
    acceptedMatrixRowMissingFirewall('accepted-source-path-only-no-shim-identity', {
      runMode: {},
      acceptanceContract: {
        artifact_identity: {
          source_paths: ['src/kernels/generic_kernel.hip'],
        },
      },
      fissionReport: {
        changed_sources: ['src/kernels/generic_kernel.hip'],
      },
      realRocmSourceDeltaExecution: {
        schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_execution.v1',
        phases: [
          {
            phaseName: 'hot_delta_1',
            sourcePath: 'src/kernels/generic_kernel.hip',
            sourceWriteObserved: true,
            compileCallAttempted: true,
          },
        ],
      },
      noShimSourceIdentity: {
        schemaVersion: 'synthi.gpu_hmr.no_shim_source_identity.v1',
        accepted: true,
        sourceIdentityPresent: true,
      },
      cpuHmrUsed: false,
      fullRebuildUsed: false,
      processRestarted: false,
    }),
  ],
});
assert.equal(sourcePathOnlyNoShimIdentityQuery.accepted, false);
assert.equal(sourcePathOnlyNoShimIdentityQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.ok(sourcePathOnlyNoShimIdentityQuery.failedGates.some((gate) =>
  gate.code === 'no_shim_source_identity_source_or_edit_hash_missing'
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
assert.equal(forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.broadRuntimeRowsComputed, true);
assert.equal(forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.broadRuntimeRowsMissing, true);
assert.ok(forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.openGaps.includes(
  'broad_runtime_rows_missing',
));
assert.ok(!forgedBroadScopeQuery.summary.broadLibraryAgnosticReadiness.openGaps.includes(
  'broad_runtime_rows_not_computed_from_matrix',
));
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

const opencl = ledger.rows.find((row) =>
  row.backend === 'opencl'
  && row.targetId === 'synthetic-opencl-preflight'
);
assert.equal(opencl?.matrixOutcome, 'refusal_proven');
assert.equal(opencl.acceptedForGpuHmr, false);
assert.equal(opencl.gpuHmrSuccess, false);
assert.equal(opencl.refusalProven, true);
assert.equal(opencl.backendEvidence.accepted, true);
assert.equal(opencl.backendEvidence.backend, 'opencl');
assert.equal(opencl.backendEvidence.backendFamily, 'opencl');
assert.deepEqual(opencl.backendEvidence.evidenceRefs, [openClPreflightEvidenceRef]);

const webgpuPreflight = ledger.rows.find((row) =>
  row.backend === 'webgpu'
  && row.targetId === 'synthetic-webgpu-preflight'
);
assert.equal(webgpuPreflight?.matrixOutcome, 'preflight_only');
assert.equal(webgpuPreflight.acceptedForGpuHmr, false);
assert.equal(webgpuPreflight.gpuHmrSuccess, false);
assert.equal(webgpuPreflight.refusalProven, false);
assert.equal(webgpuPreflight.proofChainAccepted, true);
assert.equal(webgpuPreflight.backendEvidence.accepted, true);
assert.equal(webgpuPreflight.backendEvidence.backend, 'webgpu');
assert.equal(webgpuPreflight.backendEvidence.backendFamily, 'webgpu');
assert.deepEqual(webgpuPreflight.backendEvidence.evidenceRefs, [webGpuPreflightEvidenceRef]);
assert.ok(webgpuPreflight.openGaps.includes('shader_pipeline_or_output_oracle_not_proven'));
assert.ok(!webgpuPreflight.reasons.includes('preflight_typed_backend_evidence_required'));

const oidnHipPreflight = ledger.rows.find((row) =>
  row.backend === 'oidn_hip'
  && row.targetId === 'synthetic-oidn-hip-preflight'
);
assert.equal(oidnHipPreflight?.matrixOutcome, 'preflight_only');
assert.equal(oidnHipPreflight.acceptedForGpuHmr, false);
assert.equal(oidnHipPreflight.gpuHmrSuccess, false);
assert.equal(oidnHipPreflight.refusalProven, false);
assert.equal(oidnHipPreflight.proofChainAccepted, true);
assert.equal(oidnHipPreflight.backendEvidence.accepted, true);
assert.equal(oidnHipPreflight.backendEvidence.backend, 'oidn_hip');
assert.equal(oidnHipPreflight.backendEvidence.backendFamily, 'oidn_hip');
assert.deepEqual(oidnHipPreflight.backendEvidence.evidenceRefs, [oidnHipPreflightEvidenceRef]);
assert.ok(oidnHipPreflight.openGaps.includes('oidn_output_oracle_not_proven'));
assert.ok(!oidnHipPreflight.openGaps.includes('shader_pipeline_or_output_oracle_not_proven'));
assert.ok(oidnHipPreflight.reasons.includes('preflight_only_oidn_output_oracle_still_required'));

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

const forgedRawBackendPreflightLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedRawBackendPreflightDir],
  generatedAt: '2026-06-09T00:00:00.060Z',
  includeUnproven: true,
});
const forgedRawBackendPreflight = forgedRawBackendPreflightLedger.rows.find(
  (row) => row.targetId === 'forged-raw-vulkan-backend-refs',
);
assert.equal(forgedRawBackendPreflight?.proofMode, 'runtime_preflight');
assert.equal(forgedRawBackendPreflight.matrixOutcome, 'unproven');
assert.equal(forgedRawBackendPreflight.backend, 'unknown');
assert.equal(forgedRawBackendPreflight.backendEvidence.accepted, false);
assert.ok(forgedRawBackendPreflight.backendEvidence.failedGates.some(
  (gate) => gate.code === 'preflight_backend_contract_schema_missing'
));
const forgedRawBackendPreflightCoverage = new Map(
  forgedRawBackendPreflightLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(forgedRawBackendPreflightCoverage.get('vulkan_pipeline_frame')?.status, 'missing');

const schemaCorrectRawBackendPreflightLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [schemaCorrectRawBackendPreflightDir],
  generatedAt: '2026-06-09T00:00:00.070Z',
  includeUnproven: true,
});
const schemaCorrectRawBackendPreflight = schemaCorrectRawBackendPreflightLedger.rows.find(
  (row) => row.targetId === 'schema-correct-raw-vulkan-backend',
);
assert.equal(schemaCorrectRawBackendPreflight?.proofMode, 'runtime_preflight');
assert.equal(schemaCorrectRawBackendPreflight.matrixOutcome, 'unproven');
assert.equal(schemaCorrectRawBackendPreflight.backend, 'unknown');
assert.equal(schemaCorrectRawBackendPreflight.backendEvidence.accepted, false);
assert.ok(schemaCorrectRawBackendPreflight.backendEvidence.failedGates.some(
  (gate) => gate.code === 'preflight_backend_value_missing'
));
assert.ok(schemaCorrectRawBackendPreflight.backendEvidence.failedGates.some(
  (gate) => gate.code === 'preflight_backend_field_evidence_refs_missing'
));
const schemaCorrectRawBackendPreflightCoverage = new Map(
  schemaCorrectRawBackendPreflightLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(schemaCorrectRawBackendPreflightCoverage.get('vulkan_pipeline_frame')?.status, 'missing');

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

const forgedOidnHipOutputBroadRow = withQueryRecomputedRowId({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
  artifactSchema: 'synthi.gpu_hmr.oidn_preflight.v1',
  artifactPath: 'synthetic/forged-oidn-hip-output-broad.json',
  updatedAt: '2026-06-09T00:00:00.075Z',
  backend: 'oidn_hip',
  targetId: 'forged-oidn-hip-output-broad',
  profileId: 'forged-oidn-hip-output-broad',
  proofMode: 'runtime_preflight',
  evidenceKind: 'runtime_preflight_diagnostic',
  matrixOutcome: 'full_runtime_gpu_hmr',
  acceptanceClass: 'full_runtime_gpu_hmr',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  refusalProven: false,
  proofChainAccepted: true,
  proofChain: 'runtime_preflight_only',
  acceptanceScope: 'broad_library_agnostic',
  claimScope: 'broad_library_agnostic',
  proofIds: ['oidn-preflight-proof:sha256:forged-output-broad'],
  backendEvidence: {
    accepted: true,
    backend: 'oidn_hip',
    backendFamily: 'oidn_hip',
    evidenceRefs: [oidnHipPreflightEvidenceRef],
    failedGates: [],
  },
  ledger: {
    present: false,
    proofId: null,
    gpuHmrSuccess: false,
    failedInvariants: [],
  },
  runtimeProofArtifact: {
    present: false,
    accepted: false,
    failedGates: [{ code: 'runtime_proof_artifact_missing' }],
  },
  reasons: ['forged_oidn_output_success_from_preflight'],
  openGaps: [],
});
const forgedOidnHipOutputBroadQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [forgedOidnHipOutputBroadRow],
});
assert.equal(forgedOidnHipOutputBroadQuery.accepted, false);
assert.equal(forgedOidnHipOutputBroadQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.equal(forgedOidnHipOutputBroadQuery.summary.broadFullRuntimeGpuHmrRows, 0);
assert.ok(forgedOidnHipOutputBroadQuery.failedGates.some((gate) =>
  gate.code === 'runtime_preflight_row_cannot_accept_gpu_hmr'
));
assert.ok(forgedOidnHipOutputBroadQuery.failedGates.some((gate) =>
  gate.code === 'runtime_preflight_row_cannot_report_gpu_hmr_success'
));
assert.ok(forgedOidnHipOutputBroadQuery.failedGates.some((gate) =>
  gate.code === 'runtime_preflight_row_cannot_be_full_runtime_gpu_hmr'
));
assert.ok(forgedOidnHipOutputBroadQuery.failedGates.some((gate) =>
  gate.code === 'gpu_hmr_success_requires_broad_library_agnostic_scope_proof'
));
const forgedOidnHipOutputBroadCoverage = new Map(
  forgedOidnHipOutputBroadQuery.summary.planCoverage.map((entry) => [entry.id, entry]),
);
assert.equal(forgedOidnHipOutputBroadCoverage.get('oidn_hip_output')?.status, 'missing');

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
assert.equal(externalVisual.deterministicVisualModeEvaluation.accepted, true);

const seedlessExternalVisual = ledger.rows.find(
  (row) => row.targetId === 'forged-external-engine-seedless-visual',
);
assert.equal(seedlessExternalVisual?.matrixOutcome, 'unproven');
assert.equal(seedlessExternalVisual.visual.accepted, true);
assert.equal(seedlessExternalVisual.externalProjectContract.accepted, true);
assert.equal(seedlessExternalVisual.externalProfileSelection.accepted, true);
assert.equal(seedlessExternalVisual.externalSourceDelta.accepted, true);
assert.equal(seedlessExternalVisual.externalVisualProofArtifact.accepted, false);
assert.equal(seedlessExternalVisual.externalVisualProofArtifact.deterministicAccepted, false);
assert.equal(seedlessExternalVisual.deterministicVisualModeEvaluation.accepted, false);
assert.ok(seedlessExternalVisual.reasons.includes('seed_policy_unproven'));
assert.ok(seedlessExternalVisual.openGaps.includes('deterministic_visual_mode_not_accepted'));
assert.ok(seedlessExternalVisual.externalVisualProofArtifact.failedGates.includes('seed_policy_unproven'));

const forgedExternalVisual = ledger.rows.find((row) => row.targetId === 'forged-external-engine-visual');
assert.equal(forgedExternalVisual?.matrixOutcome, 'unproven');
assert.equal(forgedExternalVisual.backend, 'unknown');
assert.equal(forgedExternalVisual.visual.accepted, false);
assert.equal(forgedExternalVisual.visual.allImagesAreDecodedPng, true);
assert.ok(forgedExternalVisual.visual.failedGates.includes('visual_artifact_declared_hash_missing'));
assert.equal(forgedExternalVisual.externalProjectContract.accepted, false);
assert.equal(forgedExternalVisual.externalProfileSelection.accepted, false);
assert.equal(forgedExternalVisual.externalSourceDelta.accepted, false);
assert.equal(forgedExternalVisual.externalVisualProofArtifact.accepted, false);
assert.ok(forgedExternalVisual.openGaps.includes('external_contract_schema_missing'));
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
assert.ok(largeRocm.realRocmProfileProofObligations.blockingGaps.includes(
  'proof_obligation_run_modes_missing',
));
assert.ok(largeRocm.realRocmProfileProofObligations.blockingGaps.includes(
  'proof_obligation_negative_edit_missing',
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
assert.ok(largeRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_run_modes_missing',
));
assert.ok(largeRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_missing',
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
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_run_modes_missing',
));
assert.ok(largeRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_missing',
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
const retainedRealRocmRows = ledger.rows.filter((row) => row.proofMode === 'real_rocm_repo_validation');
assert.equal(
  retainedRealRocmRows.filter((row) => row.targetId === 'real-rocm-large-lib').length,
  1,
  'latest alias plus retained real ROCm report must not double-count one target',
);
const retainedSecondRocm = retainedRealRocmRows.find((row) => row.targetId === 'real-rocm-second-lib');
assert.equal(retainedSecondRocm?.matrixOutcome, 'refusal_proven');
assert.equal(retainedSecondRocm.backend, 'hip');
assert.equal(retainedSecondRocm.proofChain, 'real_rocm_strict_runtime_refusal');

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

const forgedReadableNoHashDiff = ledger.rows.find((row) =>
  row.targetId === 'forged-readable-no-hash-diff'
);
assert.equal(forgedReadableNoHashDiff?.matrixOutcome, 'unproven');
assert.equal(forgedReadableNoHashDiff.acceptedForGpuHmr, false);
assert.equal(forgedReadableNoHashDiff.visual.present, true);
assert.equal(forgedReadableNoHashDiff.visual.allImagesAreDecodedPng, true);
assert.equal(forgedReadableNoHashDiff.visual.recomputedVisualPair.accepted, true);
assert.equal(forgedReadableNoHashDiff.visual.requireDeclaredHashes, true);
assert.equal(forgedReadableNoHashDiff.visual.requireDiff, true);
assert.equal(forgedReadableNoHashDiff.visual.allRequiredHashesDeclared, false);
assert.equal(forgedReadableNoHashDiff.visual.hasDiffImage, false);
assert.ok(forgedReadableNoHashDiff.visual.failedGates.includes('visual_artifact_declared_hash_missing'));
assert.ok(forgedReadableNoHashDiff.visual.failedGates.includes('visual_before_artifact_hash_missing'));
assert.ok(forgedReadableNoHashDiff.visual.failedGates.includes('visual_after_artifact_hash_missing'));
assert.ok(forgedReadableNoHashDiff.visual.failedGates.includes('visual_diff_artifact_missing'));
assert.ok(forgedReadableNoHashDiff.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpu = ledger.rows.find((row) => row.targetId === 'forged-webgpu');
assert.equal(forgedWebGpu?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpu.acceptedForGpuHmr, false);
assert.ok(forgedWebGpu.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpuSingleImage = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-single-image'
);
assert.equal(forgedWebGpuSingleImage?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuSingleImage.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuSingleImage.visual.present, true);
assert.equal(forgedWebGpuSingleImage.visual.allImagesAreDecodedPng, true);
assert.equal(forgedWebGpuSingleImage.visual.hasBeforeImage, false);
assert.equal(forgedWebGpuSingleImage.visual.hasAfterImage, false);
assert.equal(forgedWebGpuSingleImage.visual.accepted, false);
assert.ok(forgedWebGpuSingleImage.visual.failedGates.includes('visual_before_artifact_missing'));
assert.ok(forgedWebGpuSingleImage.visual.failedGates.includes('visual_after_artifact_missing'));
assert.ok(
  forgedWebGpuSingleImage.visual.failedGates.includes('visual_pair_pixel_recompute_not_accepted'),
);
assert.ok(forgedWebGpuSingleImage.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpuQueryOnly = ledger.rows.find((row) => row.targetId === 'forged-webgpu-query-only');
assert.equal(forgedWebGpuQueryOnly?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuQueryOnly.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuQueryOnly.visual.accepted, true);
assert.equal(forgedWebGpuQueryOnly.visual.allImagesAreDecodedPng, true);
assert.equal(forgedWebGpuQueryOnly.ledger.present, false);
assert.equal(forgedWebGpuQueryOnly.ledger.source, 'supplied_query_ignored_no_ledger');
assert.ok(forgedWebGpuQueryOnly.reasons.includes('proof_ledger_record_missing'));

const forgedWebGpuHashMismatch = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-hash-mismatch'
);
assert.equal(forgedWebGpuHashMismatch?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuHashMismatch.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuHashMismatch.visual.present, true);
assert.equal(forgedWebGpuHashMismatch.visual.allImagesAreDecodedPng, true);
assert.equal(forgedWebGpuHashMismatch.visual.allDeclaredHashesMatch, false);
assert.ok(forgedWebGpuHashMismatch.visual.failedGates.includes('visual_artifact_hash_mismatch'));
assert.ok(forgedWebGpuHashMismatch.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpuPathEscape = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-path-escape'
);
assert.equal(forgedWebGpuPathEscape?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuPathEscape.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuPathEscape.visual.present, true);
assert.equal(forgedWebGpuPathEscape.visual.accepted, false);
assert.ok(forgedWebGpuPathEscape.visual.images.every((image) =>
  image.decodeError === 'evidence_path_outside_allowed_roots'
));
assert.ok(forgedWebGpuPathEscape.reasons.includes('visual_artifacts_not_readable'));

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

const forgedSeedlessWebGpuVisual = ledger.rows.find((row) =>
  row.targetId === 'forged-webgpu-seedless-visual'
);
assert.equal(forgedSeedlessWebGpuVisual?.proofMode, 'webgpu_wgsl_runtime_visual');
assert.equal(forgedSeedlessWebGpuVisual.matrixOutcome, 'unproven');
assert.equal(forgedSeedlessWebGpuVisual.acceptedForGpuHmr, false);
assert.equal(forgedSeedlessWebGpuVisual.ledger.gpuHmrSuccess, true);
assert.equal(forgedSeedlessWebGpuVisual.visual.accepted, true);
assert.equal(forgedSeedlessWebGpuVisual.deterministicVisualModeEvaluation.accepted, false);
assert.ok(forgedSeedlessWebGpuVisual.deterministicVisualModeEvaluation.failedGates.some(
  (failure) => failure.code === 'seed_policy_unproven',
));
assert.ok(forgedSeedlessWebGpuVisual.reasons.includes('deterministic_visual_mode_not_accepted'));
assert.ok(forgedSeedlessWebGpuVisual.reasons.includes('seed_policy_unproven'));
assert.ok(forgedSeedlessWebGpuVisual.openGaps.includes('seed_policy_unproven'));

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
const retainedRealRocmRefusalCount = retainedRealRocmRows
  .filter((row) => row.matrixOutcome === 'refusal_proven').length;
assert.equal(retainedRealRocmRefusalCount, 2);
assert.equal(ledger.summary.refusalProvenRows, 4 + retainedRealRocmRefusalCount);
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
assert.ok(!coverageById.get('opencl_dispatch_readback')?.rows.some((row) =>
  row.targetId === 'forged-generic-opencl-label'
));
assert.equal(coverageById.get('cuda_runtime')?.status, 'not_applicable');
assert.equal(coverageById.get('cuda_runtime')?.not_applicable, true);
assert.equal(coverageById.get('cuda_runtime')?.hardwareScope, 'rocm_amd_local_run');
assert.deepEqual(coverageById.get('cuda_runtime')?.openGaps, []);
assert.equal(coverageById.get('bevy_file_loaded_wgsl')?.status, 'refused');
assert.equal(coverageById.get('large_real_rocm_repo')?.status, 'refused');
assert.ok(coverageById.get('large_real_rocm_repo')?.openGaps.includes('output_or_visual_oracle_proof_required'));
assert.equal(coverageById.get('large_real_rocm_repo:real-rocm-large-lib')?.status, 'refused');
assert.equal(coverageById.get('large_real_rocm_repo:real-rocm-large-lib')?.rowCount, 1);
assert.ok(coverageById.get('large_real_rocm_repo:real-rocm-large-lib')?.openGaps.includes(
  'output_or_visual_oracle_proof_required',
));
const largeRocmCoverage = coverageById.get('large_real_rocm_repo:real-rocm-large-lib');
assert.equal(largeRocmCoverage?.appHookContract.required, true);
assert.equal(largeRocmCoverage.appHookContract.proven, false);
assert.equal(largeRocmCoverage.appHookContract.status, 'contract_missing_or_unproven');
assert.ok(largeRocmCoverage.appHookContract.blockingGaps.includes('real_rocm_app_hook_contract_required'));
assert.equal(largeRocmCoverage.sameProcessRuntimeOracleContract.required, true);
assert.equal(largeRocmCoverage.sameProcessRuntimeOracleContract.proven, false);
assert.equal(largeRocmCoverage.sameProcessRuntimeOracleContract.status, 'contract_missing_or_unproven');
assert.equal(largeRocmCoverage.deviceSidecarContract.required, true);
assert.equal(largeRocmCoverage.deviceSidecarContract.proven, false);
assert.equal(largeRocmCoverage.deviceSidecarContract.status, 'device_sidecar_missing_or_unproven');
assert.ok(largeRocmCoverage.deviceSidecarContract.blockingGaps.includes(
  'device_sidecar_dispatch_trace_runtime_not_observed',
));
assert.equal(largeRocmCoverage.sidecarRuntimeConsistency.required, true);
assert.equal(largeRocmCoverage.sidecarRuntimeConsistency.proven, false);
assert.equal(largeRocmCoverage.sidecarRuntimeConsistency.status, 'consistency_missing_or_unproven');
assert.ok(largeRocmCoverage.sidecarRuntimeConsistency.blockingGaps.includes(
  'sidecar_runtime_sidecar_observation_missing',
));

const contradictoryRealRocmCoverageQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [{
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    artifactSchema: 'synthi.gpu_hmr.real_rocm_repo_validation.v1',
    artifactPath: 'synthetic/real-rocm-contradictory-contracts.json',
    updatedAt: '2026-06-09T00:00:00.080Z',
    backend: 'hip',
    targetId: 'real-rocm-contradictory-contracts',
    profileId: 'real-rocm-contradictory-contracts',
    proofMode: 'real_rocm_repo_validation',
    evidenceKind: 'real_rocm_repo_refusal',
    matrixOutcome: 'refusal_proven',
    acceptanceClass: 'refusal_proven',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven: true,
    proofChainAccepted: true,
    proofChain: 'structured_runtime_refusal',
    proofIds: ['real-rocm-contradictory-contracts-proof:sha256:refusal'],
    ledger: {
      present: true,
      proofId: 'real-rocm-contradictory-contracts-ledger:sha256:refusal',
      gpuHmrSuccess: false,
      failedInvariants: ['runtime_proof_missing'],
    },
    reasons: ['runtime_proof_missing'],
    openGaps: ['output_or_visual_oracle_proof_required'],
    realRocmAppHookContract: {
      required: true,
      accepted: true,
      canSatisfyRuntimeProof: true,
      blockingGaps: ['contradictory_app_hook_gap'],
      blocking_gaps: ['contradictory_app_hook_gap'],
    },
    realRocmSameProcessRuntimeOracle: {
      required: true,
      accepted: true,
      canSatisfyRuntimeProof: true,
      failedGaps: ['contradictory_oracle_gap'],
      failed_gaps: ['contradictory_oracle_gap'],
    },
    realRocmDeviceSidecarContract: {
      accepted: true,
      proven: true,
      failedGates: [{ code: 'contradictory_sidecar_gate' }],
      failed_gates: [{ code: 'contradictory_sidecar_gate' }],
    },
    realRocmSidecarRuntimeConsistency: {
      accepted: true,
      runtimeConsistencyAccepted: true,
      blockingGaps: ['contradictory_consistency_gap'],
      blocking_gaps: ['contradictory_consistency_gap'],
    },
  }],
});
const contradictoryCoverage = new Map(
  contradictoryRealRocmCoverageQuery.summary.planCoverage.map((entry) => [entry.id, entry]),
).get('large_real_rocm_repo:real-rocm-contradictory-contracts');
assert.equal(contradictoryCoverage?.status, 'refused');
assert.equal(contradictoryCoverage.appHookContract.proven, false);
assert.equal(contradictoryCoverage.appHookContract.accepted, false);
assert.equal(contradictoryCoverage.appHookContract.status, 'contract_missing_or_unproven');
assert.ok(contradictoryCoverage.appHookContract.blockingGaps.includes('contradictory_app_hook_gap'));
assert.equal(contradictoryCoverage.sameProcessRuntimeOracleContract.proven, false);
assert.equal(contradictoryCoverage.sameProcessRuntimeOracleContract.accepted, false);
assert.ok(contradictoryCoverage.sameProcessRuntimeOracleContract.blockingGaps.includes(
  'contradictory_oracle_gap',
));
assert.equal(contradictoryCoverage.deviceSidecarContract.proven, false);
assert.equal(contradictoryCoverage.deviceSidecarContract.accepted, false);
assert.equal(contradictoryCoverage.deviceSidecarContract.status, 'device_sidecar_missing_or_unproven');
assert.ok(contradictoryCoverage.deviceSidecarContract.blockingGaps.includes(
  'contradictory_sidecar_gate',
));
assert.equal(contradictoryCoverage.sidecarRuntimeConsistency.proven, false);
assert.equal(contradictoryCoverage.sidecarRuntimeConsistency.accepted, false);
assert.equal(contradictoryCoverage.sidecarRuntimeConsistency.status, 'consistency_missing_or_unproven');
assert.ok(contradictoryCoverage.sidecarRuntimeConsistency.blockingGaps.includes(
  'contradictory_consistency_gap',
));
assert.equal(coverageById.get('large_real_rocm_repo:real-rocm-second-lib')?.status, 'refused');
assert.equal(coverageById.get('webgpu_scoped_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('webgpu_empty_layout_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('webgpu_profiled_layout_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('webgpu_compute_runtime_readback')?.status, 'missing');
assert.equal(coverageById.get('webgpu_runtime_preflight')?.status, 'preflight_only');
assert.ok(coverageById.get('webgpu_runtime_preflight')?.openGaps.includes(
  'shader_pipeline_or_output_oracle_not_proven',
));
assert.equal(coverageById.get('oidn_hip_runtime_preflight')?.status, 'preflight_only');
assert.ok(coverageById.get('oidn_hip_runtime_preflight')?.openGaps.includes('oidn_output_oracle_not_proven'));
assert.equal(coverageById.get('oidn_hip_output')?.status, 'missing');
assert.ok(coverageById.get('oidn_hip_output')?.openGaps.includes('oidn_hip_runtime_proof_required'));
assert.equal(ledger.summary.broadLibraryAgnosticReadiness.broadRuntimeRows, 0);
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

const webgpuSingleFrameCold = ledger.rows.find((row) =>
  row.targetId === 'webgpu-single-frame-cold'
  && row.proofMode === 'run_mode_proof'
  && row.runMode.metricScope === 'cold'
);
assert.equal(webgpuSingleFrameCold?.matrixOutcome, 'cold_split_proven');
assert.equal(webgpuSingleFrameCold.visual.accepted, true);
assert.equal(webgpuSingleFrameCold.visual.allowSingleFrameProof, true);
assert.equal(webgpuSingleFrameCold.visual.recomputedSingleFrame.accepted, true);
assert.ok(!webgpuSingleFrameCold.visual.failedGates.includes('visual_after_artifact_missing'));
assert.ok(!webgpuSingleFrameCold.visual.failedGates.includes('visual_pair_pixel_recompute_not_accepted'));
const webgpuSingleFrameHotForged = ledger.rows.find((row) =>
  row.targetId === 'webgpu-single-frame-hot-forged'
  && row.proofMode === 'run_mode_proof'
  && row.runMode.metricScope === 'hot_delta_1'
);
assert.equal(webgpuSingleFrameHotForged?.matrixOutcome, 'unproven');
assert.equal(webgpuSingleFrameHotForged.visual.accepted, false);
assert.equal(webgpuSingleFrameHotForged.visual.allowSingleFrameProof, false);
assert.equal(webgpuSingleFrameHotForged.visual.recomputedSingleFrame.accepted, true);
assert.ok(webgpuSingleFrameHotForged.visual.failedGates.includes('visual_after_artifact_missing'));
assert.ok(webgpuSingleFrameHotForged.visual.failedGates.includes('visual_pair_pixel_recompute_not_accepted'));

const hot2RunMode = ledger.rows.find((row) =>
  row.targetId === 'flow' && row.proofMode === 'run_mode_proof' && row.runMode.metricScope === 'hot_delta_2'
);
assert.equal(hot2RunMode?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(hot2RunMode.artifactSchema, 'synthi.gpu.hmr.runtime_run_mode_proof.v1');
assert.equal(hot2RunMode.runMode.differentEdit, true);

const negativeEdit = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-negative-edit-refusal:sha256:synthetic')
);
assert.equal(negativeEdit?.matrixOutcome, 'refusal_proven');
assert.equal(negativeEdit.runModeCoverageSupport.accepted, true);
assert.equal(negativeEdit.refusalEvidence.accepted, true);
assert.ok(negativeEdit.refusalEvidence.typedRefusalModes.includes('executable_static_check'));

const forgedReasonsOnlyNegativeEdit = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-negative-edit-refusal:sha256:forged-reasons-only')
);
assert.equal(forgedReasonsOnlyNegativeEdit?.matrixOutcome, 'unproven');
assert.equal(forgedReasonsOnlyNegativeEdit.refusalEvidence.accepted, false);
assert.ok(forgedReasonsOnlyNegativeEdit.refusalEvidence.failedGates.includes(
  'negative_edit_cpu_hmr_firewall_not_explicitly_false',
));
assert.ok(forgedReasonsOnlyNegativeEdit.refusalEvidence.failedGates.includes(
  'negative_edit_structural_refusal_proof_missing',
));

const forgedUnlinkedFlowCold = ledger.rows.find((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:forged-unlinked-flow-cold')
);
assert.equal(forgedUnlinkedFlowCold?.matrixOutcome, 'cold_split_proven');
assert.equal(forgedUnlinkedFlowCold.runModeCoverageSupport.accepted, false);
assert.ok(forgedUnlinkedFlowCold.runModeCoverageSupport.failedGates.includes(
  'run_mode_support_parent_proof_id_missing',
));

const reverseArtifactNamespaceDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-artifact-namespace-reverse',
);
await writeRgbaPng(path.join(reverseArtifactNamespaceDir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(reverseArtifactNamespaceDir, 'after-hmr-first.png'), 8, 8, (x, y) => [92 + x, 104 + y, 132, 255]);
await writeRgbaPng(path.join(reverseArtifactNamespaceDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
const reverseArtifactNamespaceMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'artifact-namespace-reverse',
  visualRoot: reverseArtifactNamespaceDir,
});
const reverseArtifactNamespaceAfterHash = reverseArtifactNamespaceMaterials.proofLedgerQuery.record.artifactAfterHash
  ?? reverseArtifactNamespaceMaterials.proofLedgerQuery.record.artifact_after_hash;
const reverseArtifactNamespaceSupport = runModeCoverageSupportFor(
  reverseArtifactNamespaceMaterials,
  ['agent-split-run-mode-proof:sha256:artifact-namespace-reverse-hot1'],
  { namespaceArtifactAfterHash: false },
);
assert.match(reverseArtifactNamespaceSupport.artifactAfterHash, /^sha256:[a-f0-9]{64}$/);
await writeJson(path.join(reverseArtifactNamespaceDir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:artifact-namespace-reverse-hot1',
    'gpu-runtime-proof:sha256:artifact-namespace-reverse-hot1',
  ),
  ...reverseArtifactNamespaceMaterials,
  targetId: 'artifact-namespace-reverse',
  profileId: 'artifact-namespace-reverse',
  proofId: 'agent-split-run-mode-proof:sha256:artifact-namespace-reverse-hot1',
  artifactAfterHash: `artifact:${reverseArtifactNamespaceAfterHash}`,
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: visualArtifactSet({
    before: path.join(reverseArtifactNamespaceDir, 'before-hmr-first.png'),
    after: path.join(reverseArtifactNamespaceDir, 'after-hmr-first.png'),
    diff: path.join(reverseArtifactNamespaceDir, 'before-after-diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:artifact-namespace-reverse-hot1',
    editHash: hashValue('artifact-namespace-reverse-hot1'),
    editKind: 'gpu_artifact_edit',
  },
});
await writeJson(path.join(reverseArtifactNamespaceDir, 'cold.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  targetId: 'artifact-namespace-reverse',
  profileId: 'artifact-namespace-reverse',
  proofId: 'agent-split-run-mode-proof:sha256:artifact-namespace-reverse-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  runModeCoverageSupport: reverseArtifactNamespaceSupport,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  visualArtifacts: visualArtifactSet({
    before: path.join(reverseArtifactNamespaceDir, 'before-hmr-first.png'),
    after: path.join(reverseArtifactNamespaceDir, 'after-hmr-first.png'),
    diff: path.join(reverseArtifactNamespaceDir, 'before-after-diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split:artifact-namespace-reverse',
    editHash: hashValue('artifact-namespace-reverse-cold'),
  },
});
const reverseArtifactNamespaceLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [reverseArtifactNamespaceDir],
  generatedAt: '2026-06-09T00:00:01.005Z',
  includeUnproven: true,
});
const reverseArtifactNamespaceCoverage = new Map(
  reverseArtifactNamespaceLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const reverseArtifactNamespaceTarget = reverseArtifactNamespaceCoverage
  .get('per_target_run_modes')?.targetCoverage.find(
    (entry) => entry.targetKey === 'hip:artifact-namespace-reverse',
  );
assert.ok(reverseArtifactNamespaceTarget?.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:artifact-namespace-reverse-cold')
  && row.runModeCoverageSupport?.accepted === true
));

const mismatchedArtifactNamespaceDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-artifact-namespace-mismatch',
);
await writeRgbaPng(path.join(mismatchedArtifactNamespaceDir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(mismatchedArtifactNamespaceDir, 'after-hmr-first.png'), 8, 8, (x, y) => [96 + x, 112 + y, 144, 255]);
await writeRgbaPng(path.join(mismatchedArtifactNamespaceDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
const mismatchedArtifactNamespaceMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'artifact-namespace-mismatch',
  visualRoot: mismatchedArtifactNamespaceDir,
});
const mismatchedArtifactNamespaceSupport = {
  ...runModeCoverageSupportFor(
    mismatchedArtifactNamespaceMaterials,
    ['agent-split-run-mode-proof:sha256:artifact-namespace-mismatch-hot1'],
    { namespaceArtifactAfterHash: false },
  ),
  artifactAfterHash: hashValue('different-artifact-namespace-mismatch-after'),
};
await writeJson(path.join(mismatchedArtifactNamespaceDir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    'gpu-ledger-proof:sha256:artifact-namespace-mismatch-hot1',
    'gpu-runtime-proof:sha256:artifact-namespace-mismatch-hot1',
  ),
  ...mismatchedArtifactNamespaceMaterials,
  targetId: 'artifact-namespace-mismatch',
  profileId: 'artifact-namespace-mismatch',
  proofId: 'agent-split-run-mode-proof:sha256:artifact-namespace-mismatch-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: visualArtifactSet({
    before: path.join(mismatchedArtifactNamespaceDir, 'before-hmr-first.png'),
    after: path.join(mismatchedArtifactNamespaceDir, 'after-hmr-first.png'),
    diff: path.join(mismatchedArtifactNamespaceDir, 'before-after-diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:artifact-namespace-mismatch-hot1',
    editHash: hashValue('artifact-namespace-mismatch-hot1'),
    editKind: 'gpu_artifact_edit',
  },
});
await writeJson(path.join(mismatchedArtifactNamespaceDir, 'cold.json'), {
  ...runModeProofBase,
  schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.v1',
  targetId: 'artifact-namespace-mismatch',
  profileId: 'artifact-namespace-mismatch',
  proofId: 'agent-split-run-mode-proof:sha256:artifact-namespace-mismatch-cold',
  coldRuntimeInitialProven: true,
  cold_runtime_initial_proven: true,
  runModeCoverageSupport: mismatchedArtifactNamespaceSupport,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  visualArtifacts: visualArtifactSet({
    before: path.join(mismatchedArtifactNamespaceDir, 'before-hmr-first.png'),
    after: path.join(mismatchedArtifactNamespaceDir, 'after-hmr-first.png'),
    diff: path.join(mismatchedArtifactNamespaceDir, 'before-after-diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split:artifact-namespace-mismatch',
    editHash: hashValue('artifact-namespace-mismatch-cold'),
  },
});
const mismatchedArtifactNamespaceLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [mismatchedArtifactNamespaceDir],
  generatedAt: '2026-06-09T00:00:01.006Z',
  includeUnproven: true,
});
const mismatchedArtifactNamespaceCoverage = new Map(
  mismatchedArtifactNamespaceLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const mismatchedArtifactNamespaceTarget = mismatchedArtifactNamespaceCoverage
  .get('per_target_run_modes')?.targetCoverage.find(
    (entry) => entry.targetKey === 'hip:artifact-namespace-mismatch',
  );
assert.ok(!mismatchedArtifactNamespaceTarget?.rows.some((row) =>
  row.proofIds?.includes('agent-split-run-mode-proof:sha256:artifact-namespace-mismatch-cold')
));
assert.ok(mismatchedArtifactNamespaceCoverage.get('per_target_run_modes')?.unlinkedSupportRowCount >= 1);
assert.ok(mismatchedArtifactNamespaceTarget?.openGaps.includes(
  'hip:artifact-namespace-mismatch:cold_evidence_missing',
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
  visualArtifacts: visualArtifactSet({
    before: path.join(spoofNamedFlowDir, 'before.png'),
    after: path.join(spoofNamedFlowDir, 'after.png'),
    diff: path.join(spoofNamedFlowDir, 'diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-name-only-hot1',
    editHash: hashValue('flow-name-only-hot1'),
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
assert.equal(spoofNamedFlowCoverage.get('flow_visual_gpu_path'), undefined);

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
  visualArtifacts: visualArtifactSet({
    before: path.join(forgedAcceptedProfileDir, 'before.png'),
    after: path.join(forgedAcceptedProfileDir, 'after.png'),
    diff: path.join(forgedAcceptedProfileDir, 'diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:not-flow-forged-profile',
    editHash: hashValue('not-flow-forged-profile'),
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
assert.equal(forgedAcceptedProfileCoverage.get('flow_visual_gpu_path'), undefined);

const substringOnlyProfileDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow-substring-only-profile');
await writeRgbaPng(path.join(substringOnlyProfileDir, 'before.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(substringOnlyProfileDir, 'after.png'), 8, 8, (x, y) => [96 + x, 112 + y, 144, 255]);
await writeRgbaPng(path.join(substringOnlyProfileDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const substringOnlyProfileMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'flow',
  visualRoot: substringOnlyProfileDir,
});
await writeJson(path.join(substringOnlyProfileDir, 'hot1-substring-only-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    substringOnlyProfileMaterials.proofLedgerQuery.record.proofId,
    substringOnlyProfileMaterials.runtimeProofArtifact.proofId,
  ),
  ...substringOnlyProfileMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:flow-substring-only-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    evidenceRefs: [
      'evidence:validation-profile:flow:runtime-visual',
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:flow-substring-only-profile',
      substringOnlyProfileMaterials.proofLedgerQuery.record.proofId,
      substringOnlyProfileMaterials.runtimeProofArtifact.proofId,
    ],
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: visualArtifactSet({
    before: path.join(substringOnlyProfileDir, 'before.png'),
    after: path.join(substringOnlyProfileDir, 'after.png'),
    diff: path.join(substringOnlyProfileDir, 'diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-substring-only-profile',
    editHash: hashValue('flow-substring-only-profile'),
    editKind: 'gpu_artifact_edit',
  },
});
const substringOnlyProfileLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [substringOnlyProfileDir],
  generatedAt: '2026-06-09T00:00:01.030Z',
  includeUnproven: true,
});
const substringOnlyProfileCoverage = new Map(
  substringOnlyProfileLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const substringOnlyProfileRuntime = substringOnlyProfileLedger.rows.find((row) => row.targetId === 'flow');
assert.equal(substringOnlyProfileRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(substringOnlyProfileRuntime.validationProfileEvidence.accepted, false);
assert.ok(substringOnlyProfileRuntime.validationProfileEvidence.failedGates.includes(
  'validation_profile_evidence_refs_not_bound_to_row',
));
assert.equal(substringOnlyProfileCoverage.get('flow_visual_gpu_path'), undefined);

const explicitContractSourceProfileDir = path.join(
  logsRoot,
  'agent-split-artifacts',
  'synthetic-flow-explicit-contract-source-profile',
);
await writeRgbaPng(path.join(explicitContractSourceProfileDir, 'before.png'), 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(path.join(explicitContractSourceProfileDir, 'after.png'), 8, 8, (x, y) => [104 + x, 124 + y, 148, 255]);
await writeRgbaPng(path.join(explicitContractSourceProfileDir, 'diff.png'), 8, 8, () => [255, 255, 255, 255]);
const explicitContractSourceProfileMaterials = runtimeProofMaterials('hot_delta_1', {
  projectId: 'flow',
  visualRoot: explicitContractSourceProfileDir,
});
await writeJson(path.join(explicitContractSourceProfileDir, 'hot1-explicit-contract-source-profile.json'), {
  ...runModeProofBase,
  ...waitProofValidation(
    explicitContractSourceProfileMaterials.proofLedgerQuery.record.proofId,
    explicitContractSourceProfileMaterials.runtimeProofArtifact.proofId,
  ),
  ...explicitContractSourceProfileMaterials,
  proofId: 'agent-split-run-mode-proof:sha256:flow-explicit-contract-source-profile',
  validationProfileEvidence: validationProfileEvidenceFor({
    profileId: 'flow',
    profileClass: 'flow_visual_gpu_path',
    source: 'explicit_validation_matrix_profile_contract',
    evidenceRefs: [
      explicitContractSourceProfileMaterials.proofLedgerQuery.record.proofId,
    ],
    proofIds: [
      'agent-split-run-mode-proof:sha256:flow-explicit-contract-source-profile',
      explicitContractSourceProfileMaterials.proofLedgerQuery.record.proofId,
      explicitContractSourceProfileMaterials.runtimeProofArtifact.proofId,
    ],
  }),
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: visualArtifactSet({
    before: path.join(explicitContractSourceProfileDir, 'before.png'),
    after: path.join(explicitContractSourceProfileDir, 'after.png'),
    diff: path.join(explicitContractSourceProfileDir, 'diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:flow-explicit-contract-source-profile',
    editHash: hashValue('flow-explicit-contract-source-profile'),
    editKind: 'gpu_artifact_edit',
  },
});
const explicitContractSourceProfileLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [explicitContractSourceProfileDir],
  generatedAt: '2026-06-09T00:00:01.040Z',
  includeUnproven: true,
});
const explicitContractSourceProfileCoverage = new Map(
  explicitContractSourceProfileLedger.summary.planCoverage.map((entry) => [entry.id, entry]),
);
const explicitContractSourceProfileRuntime = explicitContractSourceProfileLedger.rows.find((row) =>
  row.targetId === 'flow'
);
assert.equal(explicitContractSourceProfileRuntime?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(explicitContractSourceProfileRuntime.validationProfileEvidence.accepted, false);
assert.ok(explicitContractSourceProfileRuntime.validationProfileEvidence.binding.accepted);
assert.ok(explicitContractSourceProfileRuntime.validationProfileEvidence.failedGates.includes(
  'validation_profile_evidence_source_not_authorized',
));
assert.equal(explicitContractSourceProfileCoverage.get('flow_visual_gpu_path'), undefined);

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
  visualArtifacts: visualArtifactSet({
    before: path.join(duplicateHot2Dir, 'before.png'),
    after: path.join(duplicateHot2Dir, 'after.png'),
    diff: path.join(duplicateHot2Dir, 'diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:duplicate-hot1',
    editHash: hashValue('same-edit'),
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
  visualArtifacts: visualArtifactSet({
    before: path.join(duplicateHot2Dir, 'before.png'),
    after: path.join(duplicateHot2Dir, 'after.png'),
    diff: path.join(duplicateHot2Dir, 'diff.png'),
  }),
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:duplicate-hot2',
    editHash: hashValue('same-edit'),
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
    targetName: 'AcceptedRocmSmallOracle',
    finalAcceptanceTarget: 'AcceptedRocmDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: false,
    nonFinalPhase: true,
    nonFinalTargetRequired: true,
    requirements: ['target_must_not_be_final_acceptance_target_when_declared', 'output_oracle_proven'],
  },
  target_progression_gates: [
    {
      name: 'target progression phase',
      status: 'pass',
      detail: 'phase=small-oracle target=AcceptedRocmSmallOracle final_target=AcceptedRocmDriver',
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
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(acceptedRealRocmDir, 'before-hmr-first.png'),
    after: path.join(acceptedRealRocmDir, 'after-hmr-first.png'),
    diff: path.join(acceptedRealRocmDir, 'before-after-diff.png'),
  }),
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
assert.equal(acceptedRealRocm?.matrixOutcome, 'target_progression_evidence');
assert.equal(acceptedRealRocm.acceptedForGpuHmr, false);
assert.equal(acceptedRealRocm.gpuHmrSuccess, false);
assert.equal(acceptedRealRocm.targetProgressionEvidence, true);
assert.equal(acceptedRealRocm.proofChainAccepted, true);
assert.equal(acceptedRealRocm.ledger.source, 'recomputed_ledger');
assert.equal(acceptedRealRocm.runtimeProofArtifact.accepted, true);
assert.equal(acceptedRealRocm.visual.present, true);
assert.equal(acceptedRealRocm.visual.accepted, true);
assert.equal(acceptedRealRocm.outputOracleResolution.selectedSource, 'profile_runtime_profile');
assert.equal(acceptedRealRocm.outputOracleResolution.contractPresent, true);
assert.equal(acceptedRealRocm.targetProgression.phase, 'small-oracle');
assert.equal(acceptedRealRocm.targetProgressionGates[0]?.status, 'pass');
assert.ok(!acceptedRealRocm.targetProgressionGates.some((gate) => gate.status === 'fail'));
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
assert.equal(acceptedRealRocm.realRocmRuntimeCapabilityPreflight.observed, true);
assert.equal(acceptedRealRocm.realRocmSidecarRuntimeConsistencyGate.accepted, true);
assert.equal(acceptedRealRocm.realRocmSidecarRuntimeConsistencyGate.notApplicable, true);
const acceptedRealRocmCoverage = new Map(acceptedRealRocmLedger.summary.planCoverage.map((entry) => [entry.id, entry]));
assert.equal(acceptedRealRocmCoverage.get('large_real_rocm_repo')?.status, 'missing');
assert.equal(acceptedRealRocmCoverage.get('large_real_rocm_repo:real-rocm-accepted-lib'), undefined);
assert.equal(acceptedRealRocmCoverage.get('per_target_run_modes')?.status, 'missing');
assert.equal(acceptedRealRocmCoverage.get('per_target_run_modes')?.targetCoverage.length, 0);
const acceptedRealRocmDefaultLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedRealRocmDir],
  generatedAt: '2026-06-09T00:00:02.001Z',
  includeUnproven: false,
});
assert.ok(acceptedRealRocmDefaultLedger.rows.some((row) =>
  row.proofMode === 'real_rocm_repo_validation'
  && row.matrixOutcome === 'target_progression_evidence'
  && row.acceptedForGpuHmr === false
));

const acceptedRealRocmSidecarDir = path.join(logsRoot, 'real-rocm-accepted-sidecar');
await writeRgbaPng(path.join(acceptedRealRocmSidecarDir, 'before-hmr-first.png'), 8, 8, () => [8, 12, 16, 255]);
await writeRgbaPng(path.join(acceptedRealRocmSidecarDir, 'after-hmr-first.png'), 8, 8, (x, y) => [120 + x, 64 + y, 192, 255]);
await writeRgbaPng(path.join(acceptedRealRocmSidecarDir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
await writeJson(path.join(acceptedRealRocmSidecarDir, 'real-rocm-accepted-sidecar.json'), {
  slug: 'gpu-real-rocm-accepted-sidecar-20260625',
  real_rocm_profile: {
    id: 'real-rocm-accepted-sidecar',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
  },
  source_url: 'https://example.invalid/rocm/accepted-sidecar.git',
  repo_commit: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  entry_file: 'src/sidecar/kernel.hip',
  delta_file: 'src/sidecar/kernel_delta.h',
  target_name: 'AcceptedSidecarDriver',
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
    targetName: 'AcceptedSidecarSmallOracle',
    finalAcceptanceTarget: 'AcceptedSidecarDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: false,
    nonFinalPhase: true,
    nonFinalTargetRequired: true,
    requirements: ['target_must_not_be_final_acceptance_target_when_declared', 'output_oracle_proven'],
  },
  target_progression_gates: [
    {
      name: 'target progression phase',
      status: 'pass',
      detail: 'phase=small-oracle target=AcceptedSidecarSmallOracle final_target=AcceptedSidecarDriver',
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
  ...realRocmRuntimeProofMaterialsWithSidecar('hot_delta_1', {
    projectId: 'real-rocm-accepted-sidecar',
    visualRoot: acceptedRealRocmSidecarDir,
    deviceSidecarOverrides: {
      artifact_identity: {
        source_paths: ['src/sidecar/kernel.hip'],
        artifact_kind: 'hsaco',
        entry_points: ['accepted_sidecar_kernel'],
        compile_target: 'gfx1201',
        compiler: '/opt/rocm/llvm/bin/amdclang++',
        compiler_args_hash: hashValue('sidecar-compile-args:accepted-sidecar'),
      },
    },
  }),
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(acceptedRealRocmSidecarDir, 'before-hmr-first.png'),
    after: path.join(acceptedRealRocmSidecarDir, 'after-hmr-first.png'),
    diff: path.join(acceptedRealRocmSidecarDir, 'before-after-diff.png'),
  }),
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-sidecar-delta',
    editHash: hashValue('real-rocm-accepted-sidecar-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-sidecar.git @ abcdefabcdef files=12000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedRealRocmSidecarLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedRealRocmSidecarDir],
  generatedAt: '2026-06-25T00:00:02.000Z',
  includeUnproven: true,
});
const acceptedRealRocmSidecar = acceptedRealRocmSidecarLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedRealRocmSidecar?.matrixOutcome, 'target_progression_evidence');
assert.equal(acceptedRealRocmSidecar.acceptedForGpuHmr, false);
assert.equal(acceptedRealRocmSidecar.gpuHmrSuccess, false);
assert.equal(acceptedRealRocmSidecar.targetProgressionEvidence, true);
assert.equal(acceptedRealRocmSidecar.realRocmSidecarRuntimeConsistencyGate.accepted, true);
assert.equal(acceptedRealRocmSidecar.realRocmSidecarRuntimeConsistencyGate.notApplicable, false);
assert.equal(acceptedRealRocmSidecar.realRocmSidecarRuntimeConsistency.status, 'sidecar_runtime_consistency_proven');
assert.equal(acceptedRealRocmSidecar.realRocmSidecarRuntimeConsistency.canSatisfyRuntimeProof, true);
assert.equal(acceptedRealRocmSidecar.realRocmDeviceSidecarContract.runtimeObservationComplete, true);
assert.equal(acceptedRealRocmSidecar.realRocmDeviceSidecarContract.canSatisfyRuntimeProof, true);

async function writeForgedRealRocmAcceptanceGateCase({
  slug,
  outputOracleResolution = null,
  runtimeCapabilityPreflight = null,
  mutateMaterials = null,
  expectedMatrixOutcome = 'target_progression_evidence',
  expectedReasons = [],
  expectedOpenGaps = [],
}) {
  const dir = path.join(logsRoot, `real-rocm-forged-${slug}`);
  await writeRgbaPng(path.join(dir, 'before-hmr-first.png'), 8, 8, () => [0, 0, 0, 255]);
  await writeRgbaPng(path.join(dir, 'after-hmr-first.png'), 8, 8, (x, y) => [84 + x, 100 + y, 132, 255]);
  await writeRgbaPng(path.join(dir, 'before-after-diff.png'), 8, 8, () => [255, 255, 255, 255]);
  const materials = realRocmRuntimeProofMaterials('hot_delta_1', {
    projectId: `real-rocm-forged-${slug}`,
    visualRoot: dir,
  });
  if (runtimeCapabilityPreflight !== null) {
    materials.runtimeCapabilityPreflight = runtimeCapabilityPreflight;
    materials.runtime_capability_preflight = runtimeCapabilityPreflight;
    materials.runtimeProofArtifact.runtimeCapabilityPreflight = runtimeCapabilityPreflight;
    materials.runtimeProofArtifact.runtime_capability_preflight = runtimeCapabilityPreflight;
    materials.runtime_proof_artifact.runtimeCapabilityPreflight = runtimeCapabilityPreflight;
    materials.runtime_proof_artifact.runtime_capability_preflight = runtimeCapabilityPreflight;
  }
  if (typeof mutateMaterials === 'function') mutateMaterials(materials);
  await writeJson(path.join(dir, `real-rocm-forged-${slug}.json`), {
    slug: `gpu-real-rocm-forged-${slug}-20260623`,
    real_rocm_profile: { id: `real-rocm-forged-${slug}` },
    source_url: `https://example.invalid/rocm/forged-${slug}.git`,
    repo_commit: 'dededededededededededededededededededede',
    entry_file: 'src/kernels/gate_entry.hip',
    delta_file: 'src/kernels/gate_delta.h',
    target_name: `ForgedGate${slug}`,
    gpu_vendor: 'rocm',
    full_runtime_proof_required: true,
    full_runtime_proven: true,
    gpu_hmr_success: true,
    output_oracle_resolution: outputOracleResolution ?? {
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
    ...materials,
    visualEvidenceArtifacts: visualArtifactSet({
      before: path.join(dir, 'before-hmr-first.png'),
      after: path.join(dir, 'after-hmr-first.png'),
      diff: path.join(dir, 'before-after-diff.png'),
    }),
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
      {
        name: 'real ROCm repo',
        status: 'pass',
        detail: `https://example.invalid/rocm/forged-${slug}.git @ dededede files=16000`,
      },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  });
  const forgedLedger = await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [dir],
    generatedAt: '2026-06-09T00:00:02.010Z',
    includeUnproven: true,
  });
  const row = forgedLedger.rows.find((entry) => entry.proofMode === 'real_rocm_repo_validation');
  assert.equal(row?.matrixOutcome, expectedMatrixOutcome);
  assert.equal(row.acceptedForGpuHmr, false);
  assert.equal(row.gpuHmrSuccess, false);
  assert.equal(row.runtimeProofArtifact.accepted, true);
  assert.equal(row.ledger.gpuHmrSuccess, true);
  for (const reason of expectedReasons) assert.ok(row.reasons.includes(reason), reason);
  for (const gap of expectedOpenGaps) assert.ok(row.openGaps.includes(gap), gap);
  return row;
}

const forgedUndertypedPreflightRocm = await writeForgedRealRocmAcceptanceGateCase({
  slug: 'undertyped-runtime-preflight',
  runtimeCapabilityPreflight: { backend: 'rocm' },
  expectedReasons: [
    'real_rocm_runtime_capability_preflight_not_proven',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_schema_missing',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_not_observed',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_api_missing',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_probe_missing',
  ],
  expectedOpenGaps: [
    'real_rocm_runtime_capability_preflight_failed',
    'real_rocm_runtime_capability_preflight:runtime_capability_preflight_evidence_refs_missing',
  ],
});
assert.equal(forgedUndertypedPreflightRocm.realRocmRuntimeCapabilityPreflight.accepted, false);

const forgedUndertypedOutputResolutionRocm = await writeForgedRealRocmAcceptanceGateCase({
  slug: 'undertyped-output-resolution',
  outputOracleResolution: {
    selectedSource: 'profile_runtime_profile',
  },
  expectedReasons: ['real_rocm_output_oracle_resolution_not_accepted'],
  expectedOpenGaps: [
    'real_rocm_output_oracle_resolution_required',
    'real_rocm_output_oracle_resolution_schema_missing',
    'real_rocm_output_oracle_contract_not_explicitly_present',
    'real_rocm_output_oracle_runtime_profile_not_explicitly_present',
    'real_rocm_output_oracle_runtime_profile_sync_not_explicitly_proven',
  ],
});
assert.equal(forgedUndertypedOutputResolutionRocm.outputOracleResolutionGate.accepted, false);

const forgedMissingSidecarRocm = await writeForgedRealRocmAcceptanceGateCase({
  slug: 'missing-sidecar-consistency',
  mutateMaterials(materials) {
    delete materials.runtimeProofArtifact.realRocmSidecarRuntimeConsistency;
    delete materials.runtimeProofArtifact.real_rocm_sidecar_runtime_consistency;
    delete materials.runtime_proof_artifact.realRocmSidecarRuntimeConsistency;
    delete materials.runtime_proof_artifact.real_rocm_sidecar_runtime_consistency;
  },
  expectedReasons: [
    'real_rocm_sidecar_runtime_consistency_not_proven',
    'real_rocm_sidecar_runtime_consistency:real_rocm_sidecar_runtime_consistency_missing',
  ],
  expectedOpenGaps: ['real_rocm_sidecar_runtime_consistency_required'],
});
assert.equal(forgedMissingSidecarRocm.realRocmSidecarRuntimeConsistencyGate.accepted, false);

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
    visualEvidenceArtifacts: visualArtifactSet({
      before: path.join(dir, 'before-hmr-first.png'),
      after: path.join(dir, 'after-hmr-first.png'),
      diff: path.join(dir, 'before-after-diff.png'),
    }),
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
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(forgedOldArtifactRocmDir, 'before-hmr-first.png'),
    after: path.join(forgedOldArtifactRocmDir, 'after-hmr-first.png'),
    diff: path.join(forgedOldArtifactRocmDir, 'before-after-diff.png'),
  }),
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
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(forgedSidecarMismatchRocmDir, 'before-hmr-first.png'),
    after: path.join(forgedSidecarMismatchRocmDir, 'after-hmr-first.png'),
    diff: path.join(forgedSidecarMismatchRocmDir, 'before-after-diff.png'),
  }),
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
assert.equal(forgedSidecarMismatch?.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedSidecarMismatch.acceptedForGpuHmr, false);
assert.equal(forgedSidecarMismatch.gpuHmrSuccess, false);
assert.equal(forgedSidecarMismatch.targetProgressionEvidence, true);
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
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(forgedRequiredHookRocmDir, 'before-hmr-first.png'),
    after: path.join(forgedRequiredHookRocmDir, 'after-hmr-first.png'),
    diff: path.join(forgedRequiredHookRocmDir, 'before-after-diff.png'),
  }),
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
assert.equal(forgedRequiredHookRocm?.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedRequiredHookRocm.acceptedForGpuHmr, false);
assert.equal(forgedRequiredHookRocm.gpuHmrSuccess, false);
assert.equal(forgedRequiredHookRocm.targetProgressionEvidence, true);
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
  visualEvidenceArtifacts: visualArtifactSet({
    before: path.join(forgedMissingHookFacetRocmDir, 'before-hmr-first.png'),
    after: path.join(forgedMissingHookFacetRocmDir, 'after-hmr-first.png'),
    diff: path.join(forgedMissingHookFacetRocmDir, 'before-after-diff.png'),
  }),
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
assert.equal(forgedMissingHookFacetRocm?.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedMissingHookFacetRocm.acceptedForGpuHmr, false);
assert.equal(forgedMissingHookFacetRocm.gpuHmrSuccess, false);
assert.equal(forgedMissingHookFacetRocm.targetProgressionEvidence, true);
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
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.semanticAccepted, true);
assert.equal(acceptedComputeRocm.outputOracleFacet.compute.expectedOutputVerified, true);
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

const acceptedNativeBridgeRocmDir = path.join(logsRoot, 'real-rocm-accepted-native-runtime-bridge');
const acceptedNativeBridgeReadback = path.join(acceptedNativeBridgeRocmDir, 'readback.bin');
const acceptedNativeBridgeBytes = Buffer.from([9, 18, 27, 36, 45, 54, 63, 72]);
await fs.mkdir(acceptedNativeBridgeRocmDir, { recursive: true });
await fs.writeFile(acceptedNativeBridgeReadback, acceptedNativeBridgeBytes);
await writeJson(`${acceptedNativeBridgeReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: acceptedNativeBridgeBytes.length,
  shape: [acceptedNativeBridgeBytes.length],
});
await writeRgbaPng(`${acceptedNativeBridgeReadback}.card.png`, 8, 8, (x, y) => [
  acceptedNativeBridgeBytes[(x + y) % acceptedNativeBridgeBytes.length],
  96 + x,
  160 + y,
  255,
]);
const acceptedNativeBridgeProofMaterials =
  realRocmComputeProofLedgerMaterials('accepted-native-runtime-bridge', {
    projectId: 'real-rocm-accepted-native-runtime-bridge',
    rawReadbackPath: acceptedNativeBridgeReadback,
    rawReadbackBytes: acceptedNativeBridgeBytes,
  });
const acceptedNativeBridgeSameProcess =
  acceptedSameProcessRuntimeOracle('accepted-native-runtime-bridge', {
    declared: false,
    appHookContractAccepted: false,
    app_hook_contract_accepted: false,
    nativeRuntimeBridgeAccepted: true,
    native_runtime_bridge_accepted: true,
    nativeRuntimeBridgeObserved: true,
    native_runtime_bridge_observed: true,
    runtimeProofBridgeAccepted: true,
    runtime_proof_bridge_accepted: true,
  });
await writeJson(path.join(acceptedNativeBridgeRocmDir, 'real-rocm-accepted-native-runtime-bridge.json'), {
  slug: 'gpu-real-rocm-accepted-native-runtime-bridge-20260626',
  real_rocm_profile: { id: 'real-rocm-accepted-native-runtime-bridge' },
  source_url: 'https://example.invalid/rocm/accepted-native-runtime-bridge.git',
  repo_commit: 'dddddddddddddddddddddddddddddddddddddddd',
  entry_file: 'src/kernels/native_bridge_entry.hip',
  delta_file: 'src/kernels/native_bridge_delta.h',
  target_name: 'AcceptedNativeRuntimeBridgeDriver',
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
  real_rocm_same_process_runtime_oracle: acceptedNativeBridgeSameProcess,
  same_process_runtime_oracle: acceptedNativeBridgeSameProcess,
  runtime_proof_artifact: {
    ...acceptedNativeBridgeProofMaterials.runtime_proof_artifact,
    realRocmSameProcessRuntimeOracle: acceptedNativeBridgeSameProcess,
    real_rocm_same_process_runtime_oracle: acceptedNativeBridgeSameProcess,
    sameProcessRuntimeOracle: acceptedNativeBridgeSameProcess,
    same_process_runtime_oracle: acceptedNativeBridgeSameProcess,
  },
  proof_ledger: acceptedNativeBridgeProofMaterials.proof_ledger,
  proofLedger: acceptedNativeBridgeProofMaterials.proofLedger,
  proof_ledger_query: acceptedNativeBridgeProofMaterials.proof_ledger_query,
  proofLedgerQuery: acceptedNativeBridgeProofMaterials.proofLedgerQuery,
  computeOracleArtifacts: acceptedNativeBridgeProofMaterials.computeOracleArtifacts,
  compute_oracle_artifacts: acceptedNativeBridgeProofMaterials.computeOracleArtifacts,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-native-runtime-bridge-delta',
    editHash: hashValue('real-rocm-accepted-native-runtime-bridge-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-native-runtime-bridge.git @ dddddddd files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedNativeBridgeLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedNativeBridgeRocmDir],
  generatedAt: '2026-06-26T00:00:02.255Z',
  includeUnproven: true,
});
const acceptedNativeBridgeRocm = acceptedNativeBridgeLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedNativeBridgeRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedNativeBridgeRocm.acceptedForGpuHmr, true);
assert.equal(acceptedNativeBridgeRocm.realRocmAppHookContractGate.required, false);
assert.equal(acceptedNativeBridgeRocm.realRocmSameProcessRuntimeOracleGate.accepted, true);
assert.equal(
  acceptedNativeBridgeRocm.realRocmSameProcessRuntimeOracleGate.checks.appHookContractAccepted,
  false,
);
assert.equal(
  acceptedNativeBridgeRocm.realRocmSameProcessRuntimeOracleGate.checks.nativeRuntimeBridgeAccepted,
  true,
);
assert.equal(
  acceptedNativeBridgeRocm.realRocmSameProcessRuntimeOracleGate.checks.runtimeProofBridgeAccepted,
  true,
);

const numericEpochComputeRocmDir = path.join(logsRoot, 'real-rocm-accepted-compute-numeric-epoch');
const numericEpochComputeRawReadback = path.join(numericEpochComputeRocmDir, 'readback.bin');
const numericEpochComputeBytes = Buffer.from([2, 4, 8, 16, 32, 64, 128, 255]);
await fs.mkdir(numericEpochComputeRocmDir, { recursive: true });
await fs.writeFile(numericEpochComputeRawReadback, numericEpochComputeBytes);
await writeJson(`${numericEpochComputeRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: numericEpochComputeBytes.length,
  shape: [numericEpochComputeBytes.length],
});
await writeRgbaPng(`${numericEpochComputeRawReadback}.card.png`, 8, 8, (x, y) => [
  numericEpochComputeBytes[(x + y) % numericEpochComputeBytes.length],
  80 + x,
  150 + y,
  255,
]);
const numericEpochComputeProofMaterials = withNumericComputeEpoch(
  realRocmComputeProofLedgerMaterials('accepted-compute-numeric-epoch', {
    projectId: 'real-rocm-accepted-compute-numeric-epoch',
    rawReadbackPath: numericEpochComputeRawReadback,
    rawReadbackBytes: numericEpochComputeBytes,
  }),
  2,
);
await writeJson(path.join(numericEpochComputeRocmDir, 'real-rocm-accepted-compute-numeric-epoch.json'), {
  slug: 'gpu-real-rocm-accepted-compute-numeric-epoch-20260626',
  real_rocm_profile: { id: 'real-rocm-accepted-compute-numeric-epoch' },
  source_url: 'https://example.invalid/rocm/accepted-compute-numeric-epoch.git',
  repo_commit: 'cccccccccccccccccccccccccccccccccccccccc',
  entry_file: 'src/kernels/compute_entry.hip',
  delta_file: 'src/kernels/compute_delta.h',
  target_name: 'AcceptedComputeNumericEpochDriver',
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
  ...numericEpochComputeProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-compute-numeric-epoch-delta',
    editHash: hashValue('real-rocm-accepted-compute-numeric-epoch-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-compute-numeric-epoch.git @ cccccccc files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const numericEpochComputeRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [numericEpochComputeRocmDir],
  generatedAt: '2026-06-09T00:00:02.260Z',
  includeUnproven: true,
});
const numericEpochComputeRocm = numericEpochComputeRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(numericEpochComputeRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(numericEpochComputeRocm.acceptedForGpuHmr, true);
assert.equal(numericEpochComputeRocm.outputOracleFacet.kind, 'compute_oracle');
assert.equal(numericEpochComputeRocm.outputOracleFacet.accepted, true);
assert.equal(numericEpochComputeRocm.outputOracleFacet.compute.epoch, '2');
assert.equal(numericEpochComputeRocm.outputOracleFacet.compute.semanticAccepted, true);
assert.equal(numericEpochComputeRocm.outputOracleFacet.compute.expectedOutputVerified, true);
assert.equal(numericEpochComputeRocm.outputOracleFacet.compute.rawReadbackByteLength, numericEpochComputeBytes.length);

const acceptedLargeMlRocmDir = path.join(logsRoot, 'real-rocm-accepted-large-ml-generic-hook');
const acceptedLargeMlRawReadback = path.join(acceptedLargeMlRocmDir, 'readback.bin');
const acceptedLargeMlBytes = Buffer.from([3, 5, 8, 13, 21, 34, 55, 89]);
await fs.mkdir(acceptedLargeMlRocmDir, { recursive: true });
await fs.writeFile(acceptedLargeMlRawReadback, acceptedLargeMlBytes);
await writeJson(`${acceptedLargeMlRawReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: acceptedLargeMlBytes.length,
  shape: [acceptedLargeMlBytes.length],
});
await writeRgbaPng(`${acceptedLargeMlRawReadback}.card.png`, 8, 8, (x, y) => [
  acceptedLargeMlBytes[(x + y) % acceptedLargeMlBytes.length],
  70 + x,
  130 + y,
  255,
]);
const acceptedLargeMlProofMaterials = realRocmComputeProofLedgerMaterials(
  'accepted-large-ml-generic-hook',
  {
    projectId: 'real-rocm-accepted-large-ml-generic-hook',
    rawReadbackPath: acceptedLargeMlRawReadback,
    rawReadbackBytes: acceptedLargeMlBytes,
  },
);
const acceptedLargeMlAppHook = acceptedRealRocmAppHookContract('accepted-large-ml-generic-hook');
const acceptedLargeMlSameProcessOracle =
  acceptedSameProcessRuntimeOracle('accepted-large-ml-generic-hook');
const acceptedLargeMlPriorArtifacts = acceptedLargeMlProofMaterials.computeOracleArtifacts;
await writeJson(path.join(acceptedLargeMlRocmDir, 'real-rocm-accepted-large-ml-generic-hook.json'), {
  slug: 'gpu-real-rocm-accepted-large-ml-generic-hook-20260625',
  real_rocm_profile: largeRocmMlProfile('real-rocm-accepted-large-ml-generic-hook'),
  source_url: 'https://example.invalid/rocm/accepted-large-ml-generic-hook.git',
  repo_commit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  entry_file: 'src/kernels/generic_large_ml_entry.hip',
  delta_file: 'src/kernels/generic_large_ml_delta.h',
  target_name: 'AcceptedLargeMlGenericHookDriver',
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
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'AcceptedLargeMlGenericHookDriver',
    finalAcceptanceTarget: 'AcceptedLargeMlGenericHookDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
  },
  target_progression_ledger: {
    schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
    provided: true,
    entries: [
      {
        phase: 'small-oracle',
        status: 'pass',
        resultState: 'gpu-hmr-output-oracle-proven',
        outputOracleProven: true,
        proofId: 'large-ml-small-oracle:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        schemaVersion: 'synthi.gpu_hmr.compute_prior_oracle.v1',
        compute_oracle_artifacts: acceptedLargeMlPriorArtifacts,
      },
      {
        phase: 'partial-reload',
        status: 'pass',
        proofId: 'large-ml-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
        partialReloadProven: true,
        fissionProven: true,
      },
      {
        phase: 'original-host-path',
        status: 'pass',
        proofId: 'large-ml-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
        originalHostPathProven: true,
        attachmentProven: true,
        hostPreservationProven: true,
        dispatchSafeProven: true,
      },
    ],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  real_rocm_profile_proof_obligations:
    acceptedLargeRocmProfileObligations('accepted-large-ml-generic-hook'),
  real_rocm_source_delta_execution:
    acceptedLargeRocmSourceDeltaExecution('accepted-large-ml-generic-hook'),
  real_rocm_app_hook_contract: acceptedLargeMlAppHook,
  real_rocm_same_process_runtime_oracle: acceptedLargeMlSameProcessOracle,
  runtime_proof_artifact: {
    ...acceptedLargeMlProofMaterials.runtime_proof_artifact,
    realRocmAppHookContract: acceptedLargeMlAppHook,
    real_rocm_app_hook_contract: acceptedLargeMlAppHook,
    realRocmSameProcessRuntimeOracle: acceptedLargeMlSameProcessOracle,
    real_rocm_same_process_runtime_oracle: acceptedLargeMlSameProcessOracle,
    sameProcessRuntimeOracle: acceptedLargeMlSameProcessOracle,
    same_process_runtime_oracle: acceptedLargeMlSameProcessOracle,
    realRocmProfileProofObligations:
      acceptedLargeRocmProfileObligations('accepted-large-ml-generic-hook'),
    real_rocm_profile_proof_obligations:
      acceptedLargeRocmProfileObligations('accepted-large-ml-generic-hook'),
    realRocmSourceDeltaExecution:
      acceptedLargeRocmSourceDeltaExecution('accepted-large-ml-generic-hook'),
    real_rocm_source_delta_execution:
      acceptedLargeRocmSourceDeltaExecution('accepted-large-ml-generic-hook'),
  },
  proof_ledger: acceptedLargeMlProofMaterials.proof_ledger,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-accepted-large-ml-generic-hook-delta',
    editHash: hashValue('real-rocm-accepted-large-ml-generic-hook-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/accepted-large-ml-generic-hook.git @ eeeeeeee files=30000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const acceptedLargeMlRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [acceptedLargeMlRocmDir],
  generatedAt: '2026-06-25T00:00:02.275Z',
  includeUnproven: true,
});
const acceptedLargeMlRocm = acceptedLargeMlRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(acceptedLargeMlRocm?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedLargeMlRocm.acceptedForGpuHmr, true);
assert.equal(acceptedLargeMlRocm.realRocmAppHookContractGate.accepted, true);
assert.equal(acceptedLargeMlRocm.realRocmSameProcessRuntimeOracleGate.accepted, true);
assert.equal(acceptedLargeMlRocm.realRocmSameProcessRuntimeOracleGate.proven, true);
assert.equal(acceptedLargeMlRocm.realRocmSourceDeltaExecution.accepted, true);
assert.equal(acceptedLargeMlRocm.realRocmSourceDeltaExecution.hotDelta2PhaseExecuted, true);
assert.equal(acceptedLargeMlRocm.realRocmSourceDeltaExecution.negativeEditPhaseExecuted, true);
assert.equal(acceptedLargeMlRocm.realRocmProfileProofObligations.blockingGaps.length, 0);
assert.equal(acceptedLargeMlRocm.outputOracleFacet.kind, 'compute_oracle');
assert.equal(acceptedLargeMlRocm.outputOracleFacet.accepted, true);

async function writeSameProcessOracleNegative({
  scope,
  appHookOverrides = {},
  sameProcessOverrides = {},
  mutateMaterials = null,
  omitSameProcessOracle = false,
  omitRuntimeProofArtifact = false,
  expectedGap,
}) {
  const dir = path.join(logsRoot, scope);
  const rawReadback = path.join(dir, 'readback.bin');
  const bytes = Buffer.from([11, 22, 33, 44, 55, 66, 77, 88]);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(rawReadback, bytes);
  await writeJson(`${rawReadback}.schema.json`, {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    elementType: 'u8',
    byteLength: bytes.length,
    shape: [bytes.length],
  });
  await writeRgbaPng(`${rawReadback}.card.png`, 8, 8, (x, y) => [
    bytes[(x + y) % bytes.length],
    50 + x,
    90 + y,
    255,
  ]);
  const materials = realRocmComputeProofLedgerMaterials(scope, {
    projectId: scope,
    rawReadbackPath: rawReadback,
    rawReadbackBytes: bytes,
  });
  if (typeof mutateMaterials === 'function') {
    mutateMaterials(materials);
  }
  const appHook = acceptedRealRocmAppHookContract(scope, appHookOverrides);
  const sameProcessOracle = omitSameProcessOracle
    ? null
    : acceptedSameProcessRuntimeOracle(scope, sameProcessOverrides);
  const runtimeProofArtifact = omitRuntimeProofArtifact
    ? null
    : {
      ...materials.runtime_proof_artifact,
      realRocmAppHookContract: appHook,
      real_rocm_app_hook_contract: appHook,
      ...(sameProcessOracle ? {
        realRocmSameProcessRuntimeOracle: sameProcessOracle,
        real_rocm_same_process_runtime_oracle: sameProcessOracle,
        sameProcessRuntimeOracle: sameProcessOracle,
        same_process_runtime_oracle: sameProcessOracle,
      } : {}),
      realRocmProfileProofObligations: acceptedLargeRocmProfileObligations(scope),
      real_rocm_profile_proof_obligations: acceptedLargeRocmProfileObligations(scope),
      realRocmSourceDeltaExecution: acceptedLargeRocmSourceDeltaExecution(scope),
      real_rocm_source_delta_execution: acceptedLargeRocmSourceDeltaExecution(scope),
    };
  await writeJson(path.join(dir, `${scope}.json`), {
    slug: `gpu-${scope}-20260625`,
    real_rocm_profile: largeRocmMlProfile(scope),
    source_url: `https://example.invalid/rocm/${scope}.git`,
    repo_commit: 'abababababababababababababababababababab',
    entry_file: `src/${scope}/entry.hip`,
    delta_file: `src/${scope}/delta.h`,
    target_name: `${scope}-driver`,
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
      required: true,
      phaseRaw: 'final-acceptance',
      phase: 'final-acceptance',
      recognized: true,
      targetName: `${scope}-driver`,
      finalAcceptanceTarget: `${scope}-driver`,
      finalAcceptanceTargetDeclared: true,
      targetMatchesFinalAcceptance: true,
    },
    target_progression_ledger: {
      schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
      provided: true,
      entries: [
        {
          phase: 'small-oracle',
          status: 'pass',
          resultState: 'gpu-hmr-output-oracle-proven',
          outputOracleProven: true,
          proofId: `${scope}-small:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
          schemaVersion: 'synthi.gpu_hmr.compute_prior_oracle.v1',
          compute_oracle_artifacts: materials.computeOracleArtifacts,
        },
        {
          phase: 'partial-reload',
          status: 'pass',
          proofId: `${scope}-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
          schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
          partialReloadProven: true,
          fissionProven: true,
        },
        {
          phase: 'original-host-path',
          status: 'pass',
          proofId: `${scope}-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc`,
          schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
          originalHostPathProven: true,
          attachmentProven: true,
          hostPreservationProven: true,
          dispatchSafeProven: true,
        },
      ],
    },
    output_proof: {
      accepted: true,
      result_state: 'gpu-hmr-output-oracle-proven',
    },
    strict_proof_gates: {
      accepted: true,
      failures: [],
    },
    real_rocm_profile_proof_obligations: acceptedLargeRocmProfileObligations(scope),
    real_rocm_source_delta_execution: acceptedLargeRocmSourceDeltaExecution(scope),
    real_rocm_app_hook_contract: appHook,
    real_rocm_same_process_runtime_oracle: sameProcessOracle,
    runtime_proof_artifact: runtimeProofArtifact,
    proof_ledger: materials.proof_ledger,
    timingMetrics: {
      schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
      source: 'real_rocm_validation',
      metricClock: 'monotonic_ns',
      metricScope: 'hot_delta_1',
      cacheState: 'compiler_cache_warm',
      editId: `${scope}-delta`,
      editHash: hashValue(`${scope}-delta`),
    },
    checks: [
      { name: 'real ROCm repo', status: 'pass', detail: `https://example.invalid/rocm/${scope}.git @ abababab files=30000` },
      { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
      { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
    ],
  });
  const negativeLedger = await collectGpuHmrValidationMatrixLedger({
    repoRoot: tmpRoot,
    mcpRoot,
    roots: [dir],
    generatedAt: '2026-06-25T00:00:02.276Z',
    includeUnproven: true,
  });
  const row = negativeLedger.rows.find((candidate) =>
    candidate.proofMode === 'real_rocm_repo_validation'
  );
  assert.equal(row?.matrixOutcome, 'unproven');
  assert.equal(row.acceptedForGpuHmr, false);
  assert.equal(row.realRocmSameProcessRuntimeOracleGate.accepted, false);
  assert.ok(row.openGaps.includes('real_rocm_same_process_runtime_oracle_required'));
  assert.ok(row.openGaps.includes(`real_rocm_same_process_runtime_oracle:${expectedGap}`));
}

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-hook',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    appHookContractAccepted: false,
    app_hook_contract_accepted: false,
    blockingGaps: ['same_process_runtime_oracle_app_hook_contract_unproven'],
    blocking_gaps: ['same_process_runtime_oracle_app_hook_contract_unproven'],
  },
  expectedGap: 'same_process_runtime_oracle_app_hook_contract_unproven',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-unresolved-hook-ref',
  appHookOverrides: {
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    status: 'declared_app_hook_contract_incomplete',
    blockingGaps: ['app_hook_epoch_publication_evidence_ref_unresolved'],
    blocking_gaps: ['app_hook_epoch_publication_evidence_ref_unresolved'],
  },
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    appHookContractAccepted: false,
    app_hook_contract_accepted: false,
    blockingGaps: ['same_process_runtime_oracle_app_hook_contract_unproven'],
    blocking_gaps: ['same_process_runtime_oracle_app_hook_contract_unproven'],
  },
  expectedGap: 'same_process_runtime_oracle_app_hook_contract_unproven',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-output-target',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    outputTargetObserved: false,
    output_target_observed: false,
    outputTargetMatched: false,
    output_target_matched: false,
    blockingGaps: ['same_process_runtime_oracle_output_target_missing'],
    blocking_gaps: ['same_process_runtime_oracle_output_target_missing'],
  },
  expectedGap: 'same_process_runtime_oracle_output_target_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-output-target-mismatch',
  sameProcessOverrides: {
    outputTargetMatched: false,
    output_target_matched: false,
  },
  expectedGap: 'same_process_runtime_oracle_output_target_mismatch',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-evidence-closure',
  sameProcessOverrides: {
    evidenceRefs: ['evidence:same-process-runtime-oracle:unbound'],
    evidence_refs: ['evidence:same-process-runtime-oracle:unbound'],
  },
  expectedGap: 'same_process_runtime_oracle_evidence_ref_closure_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-stage-results',
  sameProcessOverrides: {
    stageResults: null,
    stage_results: null,
  },
  expectedGap: 'same_process_runtime_oracle_stage_results_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-runtime-chain-mismatch',
  mutateMaterials(materials) {
    const record = materials.proof_ledger.records[0];
    const outputEvent = record.output_event ?? record.outputEvent;
    outputEvent.output_target_id = 'output-target:mutated-after-facet';
    outputEvent.outputTargetId = 'output-target:mutated-after-facet';
    materials.runtime_proof_artifact.proofLedger = materials.proof_ledger;
    materials.runtime_proof_artifact.proof_ledger = materials.proof_ledger;
  },
  expectedGap: 'same_process_runtime_oracle_runtime_chain_closure_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-facet',
  omitSameProcessOracle: true,
  expectedGap: 'same_process_runtime_oracle_contract_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-wrong-schema',
  sameProcessOverrides: {
    schemaVersion: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v0',
    schema_version: 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v0',
  },
  expectedGap: 'same_process_runtime_oracle_contract_schema_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-artifact-transport',
  sameProcessOverrides: {
    artifactTransportObserved: false,
    artifact_transport_observed: false,
  },
  expectedGap: 'same_process_runtime_oracle_artifact_transport_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-epoch-publication',
  sameProcessOverrides: {
    epochPublicationObserved: false,
    epoch_publication_observed: false,
  },
  expectedGap: 'same_process_runtime_oracle_epoch_publication_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-dispatch-trace',
  sameProcessOverrides: {
    dispatchTraceObserved: false,
    dispatch_trace_observed: false,
  },
  expectedGap: 'same_process_runtime_oracle_dispatch_trace_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-dispatch-epoch-mismatch',
  sameProcessOverrides: {
    dispatchUsedPublishedEpoch: false,
    dispatch_used_published_epoch: false,
  },
  expectedGap: 'same_process_runtime_oracle_dispatch_epoch_mismatch',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-missing-output-oracle',
  sameProcessOverrides: {
    outputOracleObserved: false,
    output_oracle_observed: false,
  },
  expectedGap: 'same_process_runtime_oracle_output_oracle_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-full-runtime-missing',
  sameProcessOverrides: {
    blockingGaps: ['same_process_runtime_oracle_full_runtime_proof_missing'],
    blocking_gaps: ['same_process_runtime_oracle_full_runtime_proof_missing'],
  },
  expectedGap: 'same_process_runtime_oracle_full_runtime_proof_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-cpu-hmr-used',
  sameProcessOverrides: {
    firewallAccepted: false,
    firewall_accepted: false,
    cpuHmrUsed: true,
    cpu_hmr_used: true,
  },
  expectedGap: 'same_process_runtime_oracle_firewall_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-full-rebuild-used',
  sameProcessOverrides: {
    firewallAccepted: false,
    firewall_accepted: false,
    fullRebuildUsed: true,
    full_rebuild_used: true,
  },
  expectedGap: 'same_process_runtime_oracle_firewall_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-process-restarted',
  sameProcessOverrides: {
    firewallAccepted: false,
    firewall_accepted: false,
    processRestarted: true,
    process_restarted: true,
  },
  expectedGap: 'same_process_runtime_oracle_firewall_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-runtime-artifact-missing',
  omitRuntimeProofArtifact: true,
  expectedGap: 'same_process_runtime_oracle_strict_runtime_proof_artifact_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-process-mismatch',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sameProcessIdentityObserved: false,
    same_process_identity_observed: false,
    blockingGaps: ['same_process_runtime_oracle_process_identity_missing'],
    blocking_gaps: ['same_process_runtime_oracle_process_identity_missing'],
  },
  expectedGap: 'same_process_runtime_oracle_process_identity_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-oracle-before-dispatch',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    outputAfterDispatchObserved: false,
    output_after_dispatch_observed: false,
    blockingGaps: ['same_process_runtime_oracle_after_dispatch_missing'],
    blocking_gaps: ['same_process_runtime_oracle_after_dispatch_missing'],
  },
  expectedGap: 'same_process_runtime_oracle_after_dispatch_missing',
});

await writeSameProcessOracleNegative({
  scope: 'real-rocm-forged-same-process-artifact-mismatch',
  sameProcessOverrides: {
    accepted: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    artifactEpochMatched: false,
    artifact_epoch_matched: false,
    blockingGaps: ['same_process_runtime_oracle_artifact_epoch_mismatch'],
    blocking_gaps: ['same_process_runtime_oracle_artifact_epoch_mismatch'],
  },
  expectedGap: 'same_process_runtime_oracle_artifact_epoch_mismatch',
});

const forgedComputeSemanticRocmDir = path.join(logsRoot, 'real-rocm-forged-compute-semantic');
const forgedComputeSemanticReadback = path.join(forgedComputeSemanticRocmDir, 'readback.bin');
const forgedComputeSemanticBytes = Buffer.from([5, 10, 15, 20, 25, 30, 35, 40]);
await fs.mkdir(forgedComputeSemanticRocmDir, { recursive: true });
await fs.writeFile(forgedComputeSemanticReadback, forgedComputeSemanticBytes);
await writeJson(`${forgedComputeSemanticReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedComputeSemanticBytes.length,
  shape: [forgedComputeSemanticBytes.length],
});
await writeRgbaPng(`${forgedComputeSemanticReadback}.card.png`, 8, 8, (x, y) => [
  forgedComputeSemanticBytes[(x + y) % forgedComputeSemanticBytes.length],
  64 + x,
  96 + y,
  255,
]);
const forgedComputeSemanticProofMaterials = stripExpectedOutputVerified(
  realRocmComputeProofLedgerMaterials('forged-compute-semantic', {
    projectId: 'real-rocm-forged-compute-semantic',
    rawReadbackPath: forgedComputeSemanticReadback,
    rawReadbackBytes: forgedComputeSemanticBytes,
  }),
);
const forgedComputeSemanticSliceLength = Math.min(4, forgedComputeSemanticBytes.length);
const forgedComputeSemanticPriorArtifacts = {
  raw_readback_bin: forgedComputeSemanticReadback,
  readback_schema_json: `${forgedComputeSemanticReadback}.schema.json`,
  checksum_before: hashValue('forged-compute-semantic-prior-before'),
  checksum_after: hashValue('forged-compute-semantic-prior-after'),
  deterministic_slice: {
    offset: 0,
    length: forgedComputeSemanticSliceLength,
    hash: hashBuffer(forgedComputeSemanticBytes.subarray(0, forgedComputeSemanticSliceLength)),
  },
  deterministic_slice_hash: hashBuffer(forgedComputeSemanticBytes.subarray(0, forgedComputeSemanticSliceLength)),
  deterministic_slice_hash_verified: true,
  oracle_code_hash: hashValue('forged-compute-semantic-prior-oracle'),
  rendered_card_png: `${forgedComputeSemanticReadback}.card.png`,
  producer: 'synthetic_compute_oracle',
  timestamp_after_dispatch: 4000,
  epoch: 'epoch:forged-compute-semantic',
  raw_readback_hash: hashBuffer(forgedComputeSemanticBytes),
  raw_readback_hash_verified: true,
  raw_readback_byte_length: forgedComputeSemanticBytes.length,
  raw_readback_source: 'runtime_raw_readback',
  output_change_expected: true,
};
await writeJson(path.join(forgedComputeSemanticRocmDir, 'real-rocm-forged-compute-semantic.json'), {
  slug: 'gpu-real-rocm-forged-compute-semantic-20260625',
  real_rocm_profile: { id: 'real-rocm-forged-compute-semantic' },
  source_url: 'https://example.invalid/rocm/forged-compute-semantic.git',
  repo_commit: 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd',
  entry_file: 'src/kernels/compute_semantic_entry.hip',
  delta_file: 'src/kernels/compute_semantic_delta.h',
  target_name: 'ForgedComputeSemanticDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  target_progression: {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedComputeSemanticDriver',
    finalAcceptanceTarget: 'ForgedComputeSemanticDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
  },
  target_progression_ledger: {
    schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
    provided: true,
    entries: [
      {
        phase: 'small-oracle',
        status: 'pass',
        resultState: 'gpu-hmr-output-oracle-proven',
        outputOracleProven: true,
        proofId: 'compute-semantic-small-oracle:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        schemaVersion: 'synthi.gpu_hmr.compute_prior_oracle.v1',
        compute_oracle_artifacts: forgedComputeSemanticPriorArtifacts,
      },
      {
        phase: 'partial-reload',
        status: 'pass',
        proofId: 'compute-semantic-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
        partialReloadProven: true,
        fissionProven: true,
      },
      {
        phase: 'original-host-path',
        status: 'pass',
        proofId: 'compute-semantic-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
        originalHostPathProven: true,
        attachmentProven: true,
        hostPreservationProven: true,
        dispatchSafeProven: true,
      },
    ],
  },
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
  ...forgedComputeSemanticProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-compute-semantic-delta',
    editHash: hashValue('real-rocm-forged-compute-semantic-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-compute-semantic.git @ cdcdcdcd files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedComputeSemanticLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedComputeSemanticRocmDir],
  generatedAt: '2026-06-25T00:00:02.300Z',
  includeUnproven: true,
});
const forgedComputeSemanticRocm = forgedComputeSemanticLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
const forgedComputeSemanticSmallOracleGate = forgedComputeSemanticRocm?.targetProgressionGates.find(
  (gate) => gate.name === 'target progression prior small-oracle',
);
assert.equal(forgedComputeSemanticRocm?.matrixOutcome, 'unproven');
assert.equal(forgedComputeSemanticRocm.acceptedForGpuHmr, false);
assert.equal(forgedComputeSemanticRocm.outputOracleFacet.kind, 'ledger_rejected');
assert.equal(forgedComputeSemanticSmallOracleGate?.status, 'fail');
assert.match(forgedComputeSemanticSmallOracleGate?.detail ?? '', /compute_oracle_expected_output_not_verified/);
assert.ok(forgedComputeSemanticRocm.reasons.includes(
  'target_progression_gate_failed:target progression prior small-oracle',
));
assert.ok(forgedComputeSemanticRocm.openGaps.includes('target_progression_gates_failed'));

const forgedFinalMissingFixturesRocmDir = path.join(logsRoot, 'real-rocm-forged-final-missing-fixtures');
const forgedFinalMissingFixturesReadback = path.join(forgedFinalMissingFixturesRocmDir, 'readback.bin');
const forgedFinalMissingFixturesBytes = Buffer.from([2, 4, 8, 16, 32, 64, 128, 255]);
await fs.mkdir(forgedFinalMissingFixturesRocmDir, { recursive: true });
await fs.writeFile(forgedFinalMissingFixturesReadback, forgedFinalMissingFixturesBytes);
await writeJson(`${forgedFinalMissingFixturesReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedFinalMissingFixturesBytes.length,
  shape: [forgedFinalMissingFixturesBytes.length],
});
await writeRgbaPng(`${forgedFinalMissingFixturesReadback}.card.png`, 8, 8, (x, y) => [
  forgedFinalMissingFixturesBytes[(x + y) % forgedFinalMissingFixturesBytes.length],
  72 + x,
  108 + y,
  255,
]);
const forgedFinalMissingFixturesProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-final-missing-fixtures',
  {
    projectId: 'real-rocm-forged-final-missing-fixtures',
    rawReadbackPath: forgedFinalMissingFixturesReadback,
    rawReadbackBytes: forgedFinalMissingFixturesBytes,
  },
);
await writeJson(path.join(forgedFinalMissingFixturesRocmDir, 'real-rocm-forged-final-missing-fixtures.json'), {
  slug: 'gpu-real-rocm-forged-final-missing-fixtures-20260625',
  real_rocm_profile: {
    id: 'real-rocm-forged-final-missing-fixtures',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    targetClass: 'large_rocm_ml_infrastructure',
    target: {
      entryFile: 'src/kernels/final_fixture_entry.hip',
      deltaFile: 'src/kernels/final_fixture_delta.h',
    },
    sourceDelta: {
      before: 'value = value + 1;',
      after: 'value = value + 2;',
    },
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requiresOutputOracle: true,
      requiresRunModes: true,
      requiresNegativeEdit: true,
    },
  },
  source_url: 'https://example.invalid/rocm/forged-final-missing-fixtures.git',
  repo_commit: 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1',
  entry_file: 'src/kernels/final_fixture_entry.hip',
  delta_file: 'src/kernels/final_fixture_delta.h',
  target_name: 'ForgedFinalMissingFixturesDriver',
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
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedFinalMissingFixturesDriver',
    finalAcceptanceTarget: 'ForgedFinalMissingFixturesDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    requirements: ['output_oracle_proven'],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedFinalMissingFixturesProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-final-missing-fixtures-delta',
    editHash: hashValue('real-rocm-forged-final-missing-fixtures-delta'),
  },
  checks: [
    {
      name: 'real ROCm repo',
      status: 'pass',
      detail: 'https://example.invalid/rocm/forged-final-missing-fixtures.git @ f1f1f1f1 files=18000',
    },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedFinalMissingFixturesRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedFinalMissingFixturesRocmDir],
  generatedAt: '2026-06-25T00:00:02.400Z',
  includeUnproven: true,
});
const forgedFinalMissingFixturesRocm = forgedFinalMissingFixturesRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedFinalMissingFixturesRocm?.matrixOutcome, 'unproven');
assert.notEqual(forgedFinalMissingFixturesRocm.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedFinalMissingFixturesRocm.acceptedForGpuHmr, false);
assert.equal(forgedFinalMissingFixturesRocm.targetProgressionEvidence, false);
assert.equal(forgedFinalMissingFixturesRocm.runtimeProofArtifact.accepted, true);
assert.equal(forgedFinalMissingFixturesRocm.ledger.gpuHmrSuccess, true);
assert.equal(forgedFinalMissingFixturesRocm.outputOracleFacet.accepted, true);
assert.equal(forgedFinalMissingFixturesRocm.outputOracleResolutionGate.accepted, true);
assert.equal(forgedFinalMissingFixturesRocm.realRocmProfileProofObligations.requiresRunModesDeclared, true);
assert.equal(forgedFinalMissingFixturesRocm.realRocmProfileProofObligations.requiresNegativeEditDeclared, true);
assert.equal(forgedFinalMissingFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2Declared, false);
assert.equal(forgedFinalMissingFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditDeclared, false);
assert.ok(forgedFinalMissingFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_fixture_missing',
));
assert.ok(forgedFinalMissingFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_fixture_missing',
));
assert.ok(forgedFinalMissingFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_fixture_missing',
));
assert.ok(forgedFinalMissingFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_fixture_missing',
));

const forgedFinalUnexecutedFixturesRocmDir = path.join(logsRoot, 'real-rocm-forged-final-unexecuted-fixtures');
const forgedFinalUnexecutedFixturesProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-final-unexecuted-fixtures',
  {
    projectId: 'real-rocm-forged-final-unexecuted-fixtures',
    rawReadbackPath: forgedFinalMissingFixturesReadback,
    rawReadbackBytes: forgedFinalMissingFixturesBytes,
  },
);
await writeJson(path.join(forgedFinalUnexecutedFixturesRocmDir, 'real-rocm-forged-final-unexecuted-fixtures.json'), {
  slug: 'gpu-real-rocm-forged-final-unexecuted-fixtures-20260625',
  real_rocm_profile: {
    id: 'real-rocm-forged-final-unexecuted-fixtures',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    target: {
      entryFile: 'src/kernels/final_fixture_entry.hip',
      deltaFile: 'src/kernels/final_fixture_delta.h',
    },
    sourceDelta: {
      before: 'value = value + 1;',
      after: 'value = value + 2;',
      second: {
        file: 'src/kernels/final_fixture_delta.h',
        before: 'value = value + 2;',
        after: 'value = value + 3;',
      },
      extraDeltas: [{
        label: 'negative-edit',
        kind: 'negative_edit',
        expectedRefusal: true,
        file: 'src/kernels/final_fixture_delta.h',
        before: 'value = value + 3;',
        after: 'value = layout_breaking(value);',
      }],
    },
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requiresOutputOracle: true,
      requiresRunModes: true,
      requiresNegativeEdit: true,
    },
  },
  source_url: 'https://example.invalid/rocm/forged-final-unexecuted-fixtures.git',
  repo_commit: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
  entry_file: 'src/kernels/final_fixture_entry.hip',
  delta_file: 'src/kernels/final_fixture_delta.h',
  target_name: 'ForgedFinalUnexecutedFixturesDriver',
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
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedFinalUnexecutedFixturesDriver',
    finalAcceptanceTarget: 'ForgedFinalUnexecutedFixturesDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    requirements: ['output_oracle_proven'],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedFinalUnexecutedFixturesProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-final-unexecuted-fixtures-delta',
    editHash: hashValue('real-rocm-forged-final-unexecuted-fixtures-delta'),
  },
  checks: [
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
  ],
});
const forgedFinalUnexecutedFixturesRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedFinalUnexecutedFixturesRocmDir],
  generatedAt: '2026-06-25T00:00:02.500Z',
  includeUnproven: true,
});
const forgedFinalUnexecutedFixturesRocm = forgedFinalUnexecutedFixturesRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedFinalUnexecutedFixturesRocm?.matrixOutcome, 'unproven');
assert.equal(forgedFinalUnexecutedFixturesRocm.acceptedForGpuHmr, false);
assert.equal(forgedFinalUnexecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2Declared, true);
assert.equal(forgedFinalUnexecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditDeclared, true);
assert.equal(forgedFinalUnexecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2PhaseExecuted, false);
assert.equal(forgedFinalUnexecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditPhaseExecuted, false);
assert.ok(forgedFinalUnexecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(forgedFinalUnexecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_phase_not_executed',
));
assert.ok(forgedFinalUnexecutedFixturesRocm.reasons.includes(
  'real_rocm_source_delta_execution:source_delta_execution_missing',
));
assert.ok(forgedFinalUnexecutedFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(forgedFinalUnexecutedFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_phase_not_executed',
));

const compactSerializedFixturesRocmDir = path.join(logsRoot, 'real-rocm-compact-serialized-fixtures');
const compactSerializedFixturesProofMaterials = realRocmComputeProofLedgerMaterials(
  'compact-serialized-fixtures',
  {
    projectId: 'real-rocm-compact-serialized-fixtures',
    rawReadbackPath: forgedFinalMissingFixturesReadback,
    rawReadbackBytes: forgedFinalMissingFixturesBytes,
  },
);
await writeJson(path.join(compactSerializedFixturesRocmDir, 'real-rocm-compact-serialized-fixtures.json'), {
  slug: 'gpu-real-rocm-compact-serialized-fixtures-20260626',
  real_rocm_profile: {
    id: 'real-rocm-compact-serialized-fixtures',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    target: {
      entryFile: 'src/kernels/final_fixture_entry.hip',
      deltaFile: 'src/kernels/final_fixture_delta.h',
    },
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requiresOutputOracle: true,
      requiresRunModes: true,
      requiresNegativeEdit: true,
    },
  },
  real_rocm_profile_proof_obligations: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations_facet.v1',
    status: 'profile_proof_obligations_unmet',
    proofAuthority: 'profile_configuration_gate_not_runtime_proof',
    sourceDeltaFixtures: {
      schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_fixtures.v1',
      proofAuthority: 'profile_configuration_only_not_runtime_proof',
      hotDelta2Declared: true,
      hot_delta_2_declared: true,
      secondDeltaDeclared: true,
      second_delta_declared: true,
      negativeEditDeclared: true,
      negative_edit_declared: true,
      fallbackFile: 'src/kernels/final_fixture_delta.h',
      fallback_file: 'src/kernels/final_fixture_delta.h',
      executableExtraDeltaCount: 1,
      executable_extra_delta_count: 1,
      hotDelta2FixtureCount: 1,
      hot_delta_2_fixture_count: 1,
      negativeEditFixtureCount: 1,
      negative_edit_fixture_count: 1,
    },
  },
  source_url: 'https://example.invalid/rocm/compact-serialized-fixtures.git',
  repo_commit: 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1',
  entry_file: 'src/kernels/final_fixture_entry.hip',
  delta_file: 'src/kernels/final_fixture_delta.h',
  target_name: 'CompactSerializedFixturesDriver',
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
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'CompactSerializedFixturesDriver',
    finalAcceptanceTarget: 'CompactSerializedFixturesDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    requirements: ['output_oracle_proven'],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...compactSerializedFixturesProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-compact-serialized-fixtures-delta',
    editHash: hashValue('real-rocm-compact-serialized-fixtures-delta'),
  },
  checks: [
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
  ],
});
const compactSerializedFixturesRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [compactSerializedFixturesRocmDir],
  generatedAt: '2026-06-26T00:00:02.550Z',
  includeUnproven: true,
});
const compactSerializedFixturesRocm = compactSerializedFixturesRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(compactSerializedFixturesRocm?.matrixOutcome, 'unproven');
assert.equal(compactSerializedFixturesRocm.acceptedForGpuHmr, false);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.profileSourceDeltaPresent, false);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.serializedConfigurationUsed, true);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2Declared, true);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditDeclared, true);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2PhaseExecuted, false);
assert.equal(compactSerializedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditPhaseExecuted, false);
assert.ok(!compactSerializedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_fixture_missing',
));
assert.ok(!compactSerializedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_fixture_missing',
));
assert.ok(compactSerializedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(compactSerializedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_phase_not_executed',
));

const forgedFinalExecutedFixturesRocmDir = path.join(logsRoot, 'real-rocm-forged-final-executed-fixtures');
const forgedFinalExecutedFixturesProofMaterials = realRocmComputeProofLedgerMaterials(
  'forged-final-executed-fixtures',
  {
    projectId: 'real-rocm-forged-final-executed-fixtures',
    rawReadbackPath: forgedFinalMissingFixturesReadback,
    rawReadbackBytes: forgedFinalMissingFixturesBytes,
  },
);
await writeJson(path.join(forgedFinalExecutedFixturesRocmDir, 'real-rocm-forged-final-executed-fixtures.json'), {
  slug: 'gpu-real-rocm-forged-final-executed-fixtures-20260625',
  real_rocm_profile: {
    id: 'real-rocm-forged-final-executed-fixtures',
    schemaVersion: 'synthi.gpu.hmr.real_rocm_profile.v1',
    target: {
      entryFile: 'src/kernels/final_fixture_entry.hip',
      deltaFile: 'src/kernels/final_fixture_delta.h',
    },
    sourceDelta: {
      before: 'value = value + 1;',
      after: 'value = value + 2;',
      second: {
        file: 'src/kernels/final_fixture_delta.h',
        before: 'value = value + 2;',
        after: 'value = value + 3;',
      },
      extraDeltas: [{
        label: 'negative-edit',
        kind: 'negative_edit',
        expectedRefusal: true,
        file: 'src/kernels/final_fixture_delta.h',
        before: 'value = value + 3;',
        after: 'value = layout_breaking(value);',
      }],
    },
    proofObligations: {
      targetClass: 'large_rocm_ml_infrastructure',
      requiresFullRuntimeProof: true,
      requiresOutputOracle: true,
      requiresRunModes: true,
      requiresNegativeEdit: true,
      requiresAppHookContract: true,
    },
  },
  source_url: 'https://example.invalid/rocm/forged-final-executed-fixtures.git',
  repo_commit: 'd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1',
  entry_file: 'src/kernels/final_fixture_entry.hip',
  delta_file: 'src/kernels/final_fixture_delta.h',
  target_name: 'ForgedFinalExecutedFixturesDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: true,
  gpu_hmr_success: true,
  source_delta_execution: {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_execution.v1',
    phases: [
      {
        label: 'second',
        phaseKind: 'hot_delta_2',
        phaseName: 'real_repo_second_user_source_delta_hmr',
        file: 'src/kernels/final_fixture_delta.h',
        editHash: hashValue('executed-fixtures-hot-delta-2-edit'),
        sourceBeforeHash: hashValue('executed-fixtures-hot-delta-2-before'),
        sourceAfterHash: hashValue('executed-fixtures-hot-delta-2-after'),
        sourceWriteObserved: true,
        compileCallAttempted: true,
        compileCallCompleted: true,
        hmrWaitStatus: 'applied',
      },
      {
        label: 'negative-edit',
        phaseKind: 'negative_edit',
        phaseName: 'real_repo_negative-edit_user_source_delta_hmr',
        file: 'src/kernels/final_fixture_delta.h',
        editHash: hashValue('executed-fixtures-negative-edit'),
        sourceBeforeHash: hashValue('executed-fixtures-negative-before'),
        sourceAfterHash: hashValue('executed-fixtures-negative-after'),
        sourceWriteObserved: true,
        compileCallAttempted: true,
        compileCallCompleted: true,
        hmrWaitStatus: 'rejected',
        expectedRefusal: true,
      },
    ],
  },
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
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedFinalExecutedFixturesDriver',
    finalAcceptanceTarget: 'ForgedFinalExecutedFixturesDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
    requirements: ['output_oracle_proven'],
  },
  target_progression_gates: [
    { name: 'target progression phase', status: 'pass', detail: 'phase=final-acceptance' },
  ],
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedFinalExecutedFixturesProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-final-executed-fixtures-delta',
    editHash: hashValue('real-rocm-forged-final-executed-fixtures-delta'),
  },
  checks: [
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
  ],
});
const forgedFinalExecutedFixturesRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedFinalExecutedFixturesRocmDir],
  generatedAt: '2026-06-25T00:00:02.600Z',
  includeUnproven: true,
});
const forgedFinalExecutedFixturesRocm = forgedFinalExecutedFixturesRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(forgedFinalExecutedFixturesRocm?.matrixOutcome, 'unproven');
assert.equal(forgedFinalExecutedFixturesRocm.acceptedForGpuHmr, false);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmSourceDeltaExecution.present, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmSourceDeltaExecution.accepted, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2Declared, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditDeclared, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.hotDelta2PhaseExecuted, true);
assert.equal(forgedFinalExecutedFixturesRocm.realRocmProfileProofObligations.sourceDeltaFixtures.negativeEditPhaseExecuted, true);
assert.ok(!forgedFinalExecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(!forgedFinalExecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_negative_edit_phase_not_executed',
));
assert.ok(!forgedFinalExecutedFixturesRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_hot_delta_2_phase_not_executed',
));
assert.ok(forgedFinalExecutedFixturesRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_app_hook_contract_missing',
));

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
assert.notEqual(forgedFinalNoOracleRocm.matrixOutcome, 'target_progression_evidence');
assert.equal(forgedFinalNoOracleRocm.acceptedForGpuHmr, false);
assert.equal(forgedFinalNoOracleRocm.targetProgressionEvidence, false);
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
assert.ok(forgedFinalNoOracleRocm.reasons.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_raw_profile_declaration_missing',
));
assert.ok(forgedFinalNoOracleRocm.openGaps.includes('real_rocm_output_oracle_resolution_required'));
assert.ok(forgedFinalNoOracleRocm.openGaps.includes(
  'real_rocm_profile_proof_obligations:proof_obligation_raw_profile_declaration_missing',
));

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

const forgedVisualPriorRocmDir = path.join(logsRoot, 'real-rocm-forged-visual-prior-hash');
const forgedVisualPriorBefore = path.join(forgedVisualPriorRocmDir, 'prior-before.png');
const forgedVisualPriorAfter = path.join(forgedVisualPriorRocmDir, 'prior-after.png');
const forgedVisualPriorDiff = path.join(forgedVisualPriorRocmDir, 'prior-diff.png');
const forgedVisualPriorReadback = path.join(forgedVisualPriorRocmDir, 'readback.bin');
const forgedVisualPriorBytes = Buffer.from([7, 14, 21, 28, 35, 42, 49, 56]);
await writeRgbaPng(forgedVisualPriorBefore, 8, 8, () => [0, 0, 0, 255]);
await writeRgbaPng(forgedVisualPriorAfter, 8, 8, (x, y) => [72 + x, 88 + y, 120, 255]);
await writeRgbaPng(forgedVisualPriorDiff, 8, 8, () => [255, 255, 255, 255]);
await fs.writeFile(forgedVisualPriorReadback, forgedVisualPriorBytes);
await writeJson(`${forgedVisualPriorReadback}.schema.json`, {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  elementType: 'u8',
  byteLength: forgedVisualPriorBytes.length,
  shape: [forgedVisualPriorBytes.length],
});
await writeRgbaPng(`${forgedVisualPriorReadback}.card.png`, 8, 8, (x, y) => [
  forgedVisualPriorBytes[(x + y) % forgedVisualPriorBytes.length],
  80 + x,
  120 + y,
  255,
]);
const forgedVisualPriorProofMaterials = realRocmComputeProofLedgerMaterials('forged-visual-prior-hash', {
  projectId: 'real-rocm-forged-visual-prior-hash',
  rawReadbackPath: forgedVisualPriorReadback,
  rawReadbackBytes: forgedVisualPriorBytes,
});
await writeJson(path.join(forgedVisualPriorRocmDir, 'real-rocm-forged-visual-prior-hash.json'), {
  slug: 'gpu-real-rocm-forged-visual-prior-hash-20260625',
  real_rocm_profile: { id: 'real-rocm-forged-visual-prior-hash' },
  source_url: 'https://example.invalid/rocm/forged-visual-prior.git',
  repo_commit: 'dddddddddddddddddddddddddddddddddddddddd',
  entry_file: 'src/kernels/visual_prior_entry.hip',
  delta_file: 'src/kernels/visual_prior_delta.h',
  target_name: 'ForgedVisualPriorDriver',
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
    required: true,
    phaseRaw: 'final-acceptance',
    phase: 'final-acceptance',
    recognized: true,
    reason: null,
    targetName: 'ForgedVisualPriorDriver',
    finalAcceptanceTarget: 'ForgedVisualPriorDriver',
    finalAcceptanceTargetDeclared: true,
    targetMatchesFinalAcceptance: true,
  },
  target_progression_ledger: {
    schemaVersion: 'synthi.real_rocm.target_progression_ledger.v1',
    provided: true,
    entries: [
      {
        phase: 'small-oracle',
        status: 'pass',
        resultState: 'gpu-hmr-output-oracle-proven',
        outputOracleProven: true,
        proofId: 'visual-prior-small-oracle:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        schemaVersion: 'synthi.gpu_hmr.visual_prior_oracle.v1',
        visualEvidenceArtifacts: [
          { role: 'before', path: forgedVisualPriorBefore, contentHash: hashValue('wrong-prior-before') },
          { role: 'after', path: forgedVisualPriorAfter, contentHash: hashValue('wrong-prior-after') },
          { role: 'diff', path: forgedVisualPriorDiff, contentHash: hashValue('wrong-prior-diff') },
        ],
      },
      {
        phase: 'partial-reload',
        status: 'pass',
        proofId: 'visual-prior-partial:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        schemaVersion: 'synthi.gpu_hmr.partial_reload_prior.v1',
        partialReloadProven: true,
        fissionProven: true,
      },
      {
        phase: 'original-host-path',
        status: 'pass',
        proofId: 'visual-prior-host:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        schemaVersion: 'synthi.gpu_hmr.original_host_prior.v1',
        originalHostPathProven: true,
        attachmentProven: true,
        hostPreservationProven: true,
        dispatchSafeProven: true,
      },
    ],
  },
  output_proof: {
    accepted: true,
    result_state: 'gpu-hmr-output-oracle-proven',
  },
  strict_proof_gates: {
    accepted: true,
    failures: [],
  },
  ...forgedVisualPriorProofMaterials,
  timingMetrics: {
    schemaVersion: 'synthi.gpu.hmr.timing_metrics.v1',
    source: 'real_rocm_validation',
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'real-rocm-forged-visual-prior-hash-delta',
    editHash: hashValue('real-rocm-forged-visual-prior-hash-delta'),
  },
  checks: [
    { name: 'real ROCm repo', status: 'pass', detail: 'https://example.invalid/rocm/forged-visual-prior.git @ dddddddd files=18000' },
    { name: 'real_repo_user_source_delta_hmr', status: 'pass', detail: 'full_runtime_proven=true' },
    { name: 'strict runtime proof artifact presence', status: 'pass', detail: 'accepted' },
  ],
});
const forgedVisualPriorRocmLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [forgedVisualPriorRocmDir],
  generatedAt: '2026-06-25T00:00:02.450Z',
  includeUnproven: true,
});
const forgedVisualPriorRocm = forgedVisualPriorRocmLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
const forgedVisualPriorSmallOracleGate = forgedVisualPriorRocm?.targetProgressionGates.find(
  (gate) => gate.name === 'target progression prior small-oracle',
);
assert.equal(forgedVisualPriorRocm?.matrixOutcome, 'unproven');
assert.equal(forgedVisualPriorRocm.acceptedForGpuHmr, false);
assert.equal(forgedVisualPriorSmallOracleGate?.status, 'fail');
assert.match(forgedVisualPriorSmallOracleGate?.detail ?? '', /visual_artifact_hash_mismatch/);
assert.ok(forgedVisualPriorRocm.reasons.includes(
  'target_progression_gate_failed:target progression prior small-oracle',
));
assert.ok(forgedVisualPriorRocm.openGaps.includes('target_progression_gates_failed'));

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

const realRocmCompletenessDir = path.join(logsRoot, 'real-rocm-completeness-selection');
const olderCompleteRefusalPath = path.join(realRocmCompletenessDir, 'real-rocm-complete-refusal.json');
const newerWeakRefusalPath = path.join(realRocmCompletenessDir, 'real-rocm-weak-refusal.json');
const completenessBaseArtifact = {
  real_rocm_profile: { id: 'real-rocm-completeness-selection' },
  source_url: 'https://example.invalid/rocm/completeness.git',
  repo_commit: '0123456789abcdef0123456789abcdef01234567',
  entry_file: 'src/kernels/completeness_entry.hip',
  delta_file: 'src/kernels/completeness_delta.h',
  target_name: 'CompletenessDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  strict_proof_gates: {
    accepted: false,
    failures: ['runtime_full_proof_not_proven'],
  },
  checks: [
    {
      name: 'strict real ROCm runtime proof artifact acceptance',
      status: 'fail',
      detail: 'failures=runtime_full_proof_not_proven',
    },
  ],
};
await writeJson(olderCompleteRefusalPath, {
  ...completenessBaseArtifact,
  slug: 'gpu-real-rocm-completeness-selection-older-complete',
  upstream_lifecycle_failure: {
    schemaVersion: 'synthi.real_rocm.upstream_lifecycle_failure.v1',
    accepted_as_refusal_evidence: true,
    reasons: ['cmake_configure_failed'],
  },
});
await writeJson(newerWeakRefusalPath, {
  ...completenessBaseArtifact,
  slug: 'gpu-real-rocm-completeness-selection-newer-weak',
});
await fs.utimes(olderCompleteRefusalPath, new Date('2026-06-09T00:00:00.000Z'), new Date('2026-06-09T00:00:00.000Z'));
await fs.utimes(newerWeakRefusalPath, new Date('2026-06-09T00:05:00.000Z'), new Date('2026-06-09T00:05:00.000Z'));
const completenessSelectionLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [realRocmCompletenessDir],
  generatedAt: '2026-06-09T00:05:01.000Z',
});
const completenessSelectionRow = completenessSelectionLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.ok(completenessSelectionRow?.artifactPath.endsWith('real-rocm-complete-refusal.json'));
assert.equal(completenessSelectionRow.attemptCompleteness.score, 80);
assert.equal(completenessSelectionRow.attemptCompleteness.upstreamLifecycleAcceptedAsRefusalEvidence, true);

const completenessSelectionLedgerWithHistory = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [realRocmCompletenessDir],
  generatedAt: '2026-06-09T00:05:01.000Z',
  includeUnproven: true,
});
const completenessSelectionRowWithHistory = completenessSelectionLedgerWithHistory.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.ok(completenessSelectionRowWithHistory?.artifactPath.endsWith('real-rocm-complete-refusal.json'));
const completenessAttemptHistory = completenessSelectionLedgerWithHistory.attemptHistory.attempts.find(
  (attempt) => attempt.selected?.artifactPath?.endsWith('real-rocm-complete-refusal.json'),
);
assert.ok(completenessAttemptHistory);
assert.equal(completenessAttemptHistory.selectedIsLatest, false);
assert.equal(completenessAttemptHistory.latestAttemptIsUnselected, true);
assert.ok(completenessAttemptHistory.latest.artifactPath.endsWith('real-rocm-weak-refusal.json'));
assert.ok(completenessAttemptHistory.selected.artifactPath.endsWith('real-rocm-complete-refusal.json'));
assert.equal(completenessSelectionLedgerWithHistory.attemptHistory.latestUnselectedAttemptCount, 1);
assert.equal(
  completenessSelectionLedgerWithHistory.query.attemptHistory.latestUnselectedAttemptCount,
  1,
);

const workerTransferRefusalDir = path.join(logsRoot, 'real-rocm-worker-transfer-refusal');
await writeJson(path.join(workerTransferRefusalDir, 'real-rocm-worker-transfer-refusal.json'), {
  slug: 'gpu-real-rocm-worker-transfer-refusal-20260625',
  real_rocm_profile: { id: 'real-rocm-worker-transfer-refusal-generic' },
  source_url: 'https://example.invalid/rocm/generic-worker-transfer.git',
  repo_commit: '1111111111111111111111111111111111111111',
  entry_file: 'src/gpu/generic_entry.hip',
  delta_file: 'src/gpu/generic_delta.h',
  target_name: 'GenericRocmDriver',
  gpu_vendor: 'rocm',
  full_runtime_proof_required: true,
  full_runtime_proven: false,
  gpu_hmr_success: false,
  strict_proof_gates: {
    accepted: false,
    failures: ['runtime_full_proof_not_proven'],
  },
  runtime_proof_artifact: {
    proofId: 'runtime-proof-artifact:worker-transfer-refusal',
    fullRuntimeProven: false,
    full_runtime_proven: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    stageResults: [
      { stageId: 'worker-repo-transfer', status: 'failed' },
    ],
    limitations: [{ code: 'worker_repo_transfer_failed' }],
  },
  worker_repo_transfer_failure: {
    schemaVersion: 'synthi.real_rocm.worker_repo_transfer_failure.v1',
    schema_version: 'synthi.real_rocm.worker_repo_transfer_failure.v1',
    acceptedAsRefusalEvidence: true,
    accepted_as_refusal_evidence: true,
    operation: 'docker_cp',
    sourcePath: '/tmp/generic-real-rocm-source',
    source_path: '/tmp/generic-real-rocm-source',
    destinationPath: 'worker:/tmp/generic-real-rocm-repo',
    destination_path: 'worker:/tmp/generic-real-rocm-repo',
    workerContainer: 'generic-rocm-worker',
    worker_container: 'generic-rocm-worker',
    reasons: [
      'worker_repo_transfer_failed',
      'docker_copy_failed',
      'filesystem_io_error',
    ],
    errorMessage: 'Command failed: docker cp /tmp/generic-real-rocm-source worker:/tmp/generic-real-rocm-repo: input/output error',
    error_message: 'Command failed: docker cp /tmp/generic-real-rocm-source worker:/tmp/generic-real-rocm-repo: input/output error',
  },
  checks: [
    {
      name: 'worker repo transfer',
      status: 'fail',
      detail: 'operation=docker_cp reasons=worker_repo_transfer_failed,docker_copy_failed,filesystem_io_error',
    },
    {
      name: 'strict real ROCm runtime proof artifact acceptance',
      status: 'fail',
      detail: 'failures=runtime_full_proof_not_proven',
    },
  ],
});
const workerTransferRefusalLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [workerTransferRefusalDir],
  generatedAt: '2026-06-09T00:06:00.000Z',
});
const workerTransferRefusalRow = workerTransferRefusalLedger.rows.find(
  (row) => row.proofMode === 'real_rocm_repo_validation',
);
assert.equal(workerTransferRefusalRow?.matrixOutcome, 'refusal_proven');
assert.equal(workerTransferRefusalRow.acceptanceClass, 'large_real_rocm_repo_refusal');
assert.equal(workerTransferRefusalRow.acceptedForGpuHmr, false);
assert.equal(workerTransferRefusalRow.gpuHmrSuccess, false);
assert.equal(workerTransferRefusalRow.refusalProven, true);
assert.equal(workerTransferRefusalRow.proofChainAccepted, true);
assert.equal(workerTransferRefusalRow.proofChain, 'real_rocm_strict_runtime_refusal');
assert.equal(workerTransferRefusalRow.runtimeProofArtifact.present, true);
assert.equal(workerTransferRefusalRow.runtimeProofArtifact.accepted, false);
assert.ok(workerTransferRefusalRow.runtimeProofArtifact.failedGates.some(
  (failure) => failure.code === 'runtime_full_proof_not_proven',
));
assert.equal(workerTransferRefusalRow.workerRepoTransferFailure.schemaVersion,
  'synthi.real_rocm.worker_repo_transfer_failure.v1');
assert.equal(workerTransferRefusalRow.workerRepoTransferFailure.acceptedAsRefusalEvidence, true);
assert.equal(workerTransferRefusalRow.workerRepoTransferFailure.operation, 'docker_cp');
assert.ok(workerTransferRefusalRow.workerRepoTransferFailure.reasons.includes('worker_repo_transfer_failed'));
assert.ok(workerTransferRefusalRow.workerRepoTransferFailure.reasons.includes('docker_copy_failed'));
assert.ok(workerTransferRefusalRow.workerRepoTransferFailure.reasons.includes('filesystem_io_error'));
assert.equal(workerTransferRefusalRow.attemptCompleteness.score, 70);
assert.equal(workerTransferRefusalRow.attemptCompleteness.workerRepoTransferPresent, true);
assert.equal(workerTransferRefusalRow.attemptCompleteness.workerRepoTransferAcceptedAsRefusalEvidence, true);
assert.equal(workerTransferRefusalRow.attemptCompleteness.upstreamLifecycleAcceptedAsRefusalEvidence, false);
assert.equal(workerTransferRefusalRow.attemptCompleteness.accepted, false);

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  proofId: ledger.proofId,
  rows: ledger.rows.length,
}, null, 2));
