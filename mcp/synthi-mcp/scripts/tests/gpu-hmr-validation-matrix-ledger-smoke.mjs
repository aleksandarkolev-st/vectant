#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectGpuHmrValidationMatrixLedger,
  GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';
import {
  assessGeneratedGpuSplitGranularity,
  verifyGeneratedGpuSplitDeterministicFission,
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

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function hashValue(label) {
  return `sha256:${sha256Hex(label)}`;
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
      timestamp_monotonic_ns: 1000,
      process_id: 'pid:4242',
    },
    epoch_publish_event: {
      id: `epoch-publish:${scope}`,
      epoch: `epoch:${scope}`,
      artifact_hash: afterHash,
      timestamp_monotonic_ns: 2000,
      process_id: 'pid:4242',
    },
    dispatch_event: {
      id: `dispatch:${scope}`,
      epoch: `epoch:${scope}`,
      artifact_hash: afterHash,
      timestamp_monotonic_ns: 3000,
      process_id: 'pid:4242',
    },
    output_event: {
      id: `output:${scope}`,
      kind: 'visual_frame',
      epoch: `epoch:${scope}`,
      artifact_hash: afterHash,
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
    process_identity: { process_id: 'pid:4242' },
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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-validation-matrix-'));
const mcpRoot = path.join(tmpRoot, 'mcp', 'synthi-mcp');
const logsRoot = path.join(mcpRoot, '.gpu-hmr-test-logs');
const artifactsRoot = path.join(mcpRoot, '.gpu-hmr-test-artifacts');

const visualDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow');
await writePng(path.join(visualDir, 'before-hmr-first.png'));
await writePng(path.join(visualDir, 'after-hmr-first.png'));
await writePng(path.join(visualDir, 'before-after-diff.png'));
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

await writeJson(path.join(visualDir, 'run-mode-cold.json'), {
  ...runModeProofBase,
  proofId: 'agent-split-run-mode-proof:sha256:cold',
  coldSplitProven: true,
  cold_split_proven: true,
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
  ...runtimeProofMaterials('hot_delta_1'),
  proofId: 'agent-split-run-mode-proof:sha256:hot1',
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
  ...waitProofValidation('gpu-ledger-proof:sha256:synthetic-hot2', 'gpu-runtime-proof:sha256:synthetic-hot2'),
  ...runtimeProofMaterials('hot_delta_2'),
  proofId: 'agent-split-run-mode-proof:sha256:hot2',
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

await writeJson(path.join(visualDir, 'negative-edit-refusal.json'), {
  schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
  proofId: 'agent-split-negative-edit-refusal:sha256:synthetic',
  backend: 'hip',
  targetId: 'flow',
  profileId: 'flow',
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
const fissionReport = verifyGeneratedGpuSplitDeterministicFission({
  assessment: fissionAssessment,
  selectedPath: 'gpu/shading.hip',
  changedPaths: ['gpu/shading.hip'],
  selectedArtifact: {
    sourcePath: 'gpu/shading.hip',
    proofIds: [
      'gpu-runtime-proof:sha256:synthetic-fission',
      'gpu-ledger-proof:sha256:synthetic-fission',
    ],
    runtimeProofAccepted: true,
  },
  outputOracleContract: {
    oracleId: 'oracle:generated-split-visual:sha256:synthetic-fission',
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

await writeJson(path.join(artifactsRoot, 'opencl-preflight', 'opencl-proof.json'), {
  schema: 'synthi.gpu_hmr.opencl_preflight.v1',
  slug: 'synthetic-opencl-preflight',
  classification: {
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

await writeJson(path.join(logsRoot, 'external-projects', 'bevy-wgsl-shader-material-rejection-proof.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_rejection.v1',
  profileId: 'bevy-wgsl-shader-material',
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
  proofId: 'external-rejection-proof:sha256:synthetic-bevy',
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
await writePng(path.join(forgedWebGpuVisualDir, 'forged-before.png'));
await writePng(path.join(forgedWebGpuVisualDir, 'forged-after.png'));
await writePng(path.join(forgedWebGpuVisualDir, 'forged-diff.png'));
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
assert.equal(acceptedFlow.runMode.accepted, true);
assert.equal(acceptedFlow.runMode.metricScope, 'hot_delta_1');
assert.equal(acceptedFlow.visual.changedPixelRatio, 0.042);
assert.ok(acceptedFlow.ledger.proofId.startsWith('gpu-ledger-proof:sha256:'));
assert.equal(acceptedFlow.ledger.source, 'recomputed_ledger');
assert.equal(acceptedFlow.runtimeProofArtifact.accepted, true);

const opencl = ledger.rows.find((row) => row.backend === 'opencl');
assert.equal(opencl?.matrixOutcome, 'refusal_proven');
assert.equal(opencl.acceptedForGpuHmr, false);
assert.equal(opencl.gpuHmrSuccess, false);
assert.equal(opencl.refusalProven, true);

const bevy = ledger.rows.find((row) => row.backend === 'bevy_wgsl');
assert.equal(bevy?.matrixOutcome, 'refusal_proven');
assert.equal(bevy.acceptedForGpuHmr, false);
assert.ok(bevy.reasons.includes('mcp_no_decoded_frames'));
assert.ok(bevy.reasons.includes('mcp_request_timeout'));
assert.ok(bevy.reasons.includes('visual_frame_missing'));

const forgedWebGpu = ledger.rows.find((row) => row.targetId === 'forged-webgpu');
assert.equal(forgedWebGpu?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpu.acceptedForGpuHmr, false);
assert.ok(forgedWebGpu.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpuQueryOnly = ledger.rows.find((row) => row.targetId === 'forged-webgpu-query-only');
assert.equal(forgedWebGpuQueryOnly?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuQueryOnly.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuQueryOnly.visual.accepted, true);
assert.equal(forgedWebGpuQueryOnly.ledger.present, false);
assert.equal(forgedWebGpuQueryOnly.ledger.source, 'supplied_query_ignored_no_ledger');
assert.ok(forgedWebGpuQueryOnly.reasons.includes('proof_ledger_record_missing'));

const legacyAgentSplit = ledger.rows.find((row) => row.proofMode === 'mcp_preview_visual');
assert.equal(legacyAgentSplit?.matrixOutcome, 'unproven');
assert.equal(legacyAgentSplit.targetId, 'unknown');

assert.equal(ledger.summary.acceptedFullRuntimeGpuHmrRows, 2);
assert.equal(ledger.summary.refusalProvenRows, 3);
assert.ok(ledger.summary.unprovenRows >= 1);

const coverageById = new Map(ledger.summary.planCoverage.map((entry) => [entry.id, entry]));
assert.equal(coverageById.get('flow_visual_gpu_path')?.status, 'accepted');
assert.equal(coverageById.get('opencl_dispatch_readback')?.status, 'refused');
assert.equal(coverageById.get('bevy_file_loaded_wgsl')?.status, 'refused');
assert.equal(coverageById.get('webgpu_scoped_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('per_kernel_smallest_safe_fission')?.status, 'accepted');
assert.equal(coverageById.get('per_target_run_modes')?.status, 'accepted');
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

const hot2RunMode = ledger.rows.find((row) =>
  row.targetId === 'flow' && row.proofMode === 'run_mode_proof' && row.runMode.metricScope === 'hot_delta_2'
);
assert.equal(hot2RunMode?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(hot2RunMode.runMode.differentEdit, true);

const negativeEdit = ledger.rows.find((row) => row.proofMode === 'negative_edit');
assert.equal(negativeEdit?.matrixOutcome, 'refusal_proven');

const duplicateHot2Dir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow-duplicate-hot2');
await writePng(path.join(duplicateHot2Dir, 'before.png'));
await writePng(path.join(duplicateHot2Dir, 'after.png'));
await writePng(path.join(duplicateHot2Dir, 'diff.png'));
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

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  proofId: ledger.proofId,
  rows: ledger.rows.length,
}, null, 2));
