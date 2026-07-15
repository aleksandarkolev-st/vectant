#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  adversarialPreflightStrictGate,
  runtimeProofArtifactStrictGate,
  runtimeProofArtifactStrictGates,
  strictProofGateFailures,
} from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  buildGpuHmrFrameGateRuntimeBinding,
  buildGpuHmrProofLedger,
  buildGpuHmrVisualCaptureRuntimeBinding,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import { writeArtifactToCas } from './lib/gpu-hmr-artifact-cas.mjs';

const HASH_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const MODEL_AVAILABILITY_SOURCE = 'https://ai.google.dev/gemini-api/docs/deprecations';
const SELF_CHECK_ARTIFACT_DIR = path.join(
  process.cwd(),
  '.gpu-hmr-test-logs',
  'strict-gates-self-check',
);
const SELF_CHECK_CAS_ROOT = path.join(SELF_CHECK_ARTIFACT_DIR, 'cas');
mkdirSync(SELF_CHECK_ARTIFACT_DIR, { recursive: true });
mkdirSync(SELF_CHECK_CAS_ROOT, { recursive: true });

function sha256Bytes(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function contentHash(value) {
  return sha256Bytes(Buffer.from(stableJson(value)));
}

function writeVisualArtifact(name, bytes) {
  const filePath = path.join(SELF_CHECK_ARTIFACT_DIR, name);
  const buffer = Buffer.from(bytes);
  writeFileSync(filePath, buffer);
  return {
    path: filePath,
    hash: sha256Bytes(buffer),
  };
}

async function rgbaPng(width, height, pixelAt) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixelAt(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = a;
    }
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const VISUAL_BEFORE = writeVisualArtifact(
  'before-frame.png',
  await rgbaPng(2, 2, () => [12, 20, 28, 255]),
);
const VISUAL_AFTER = writeVisualArtifact(
  'after-frame.png',
  await rgbaPng(2, 2, (x, y) => [80 + x, 96 + y, 120, 255]),
);
const VISUAL_DIFF = writeVisualArtifact(
  'diff-frame.png',
  await rgbaPng(2, 2, () => [255, 255, 255, 255]),
);
const VISUAL_INVALID = writeVisualArtifact('invalid-frame.bin', [0x89, 0x50, 0x4e, 0x47, 1]);
const corruptPngBytes = Buffer.from(readFileSync(VISUAL_BEFORE.path));
corruptPngBytes[corruptPngBytes.length - 1] ^= 0xff;
const VISUAL_CORRUPT = writeVisualArtifact('corrupt-frame.png', corruptPngBytes);
const COMPUTE_RAW_BYTES = Buffer.from(Array.from({ length: 128 }, (_, index) =>
  (index * 17 + 23) % 256
));
const COMPUTE_RAW_PATH = path.join(SELF_CHECK_ARTIFACT_DIR, 'strict-readback-after.bin');
writeFileSync(COMPUTE_RAW_PATH, COMPUTE_RAW_BYTES);
const COMPUTE_RAW_HASH = sha256Bytes(COMPUTE_RAW_BYTES);
const COMPUTE_SLICE_BYTES = COMPUTE_RAW_BYTES.subarray(0, 64);
const COMPUTE_SLICE_HASH = sha256Bytes(COMPUTE_SLICE_BYTES);

async function visualCasLocator(artifact, role) {
  return writeArtifactToCas(readFileSync(artifact.path), {
    artifactRoot: SELF_CHECK_CAS_ROOT,
    artifactKind: 'visual_frame',
    mediaType: 'image/png',
    role,
    producer: {
      name: 'strict_gates_self_check',
      kind: 'visual_proof_worker',
    },
    producerSubsystem: 'strict_visual_self_check',
    sessionNamespace: 'strict_gates',
    transportKind: 'cas_shared_volume',
  });
}

const VISUAL_BEFORE_CAS = await visualCasLocator(VISUAL_BEFORE, 'before_frame');
const VISUAL_AFTER_CAS = await visualCasLocator(VISUAL_AFTER, 'after_frame');
const VISUAL_DIFF_CAS = await visualCasLocator(VISUAL_DIFF, 'diff_frame');

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
    raw_readback_bin: COMPUTE_RAW_PATH,
    readback_schema_json: 'memory://strict-readback-schema.json',
    checksum_before: HASH_A,
    checksum_after: COMPUTE_RAW_HASH,
    expected_output_change: true,
    deterministic_slice: {
      offset: 0,
      length: 64,
      format: 'float32',
      hash: COMPUTE_SLICE_HASH,
    },
    raw_readback_hash: COMPUTE_RAW_HASH,
    raw_readback_hash_verified: true,
    raw_readback_byte_length: COMPUTE_RAW_BYTES.length,
    raw_readback_source: 'runtime_readback_sample',
    deterministic_slice_hash: COMPUTE_SLICE_HASH,
    deterministic_slice_hash_verified: true,
    raw_readback_verification: {
      hash_verified: true,
      byte_length: COMPUTE_RAW_BYTES.length,
      deterministic_slice_hash: COMPUTE_SLICE_HASH,
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

function visualOracleArtifacts(overrides = {}) {
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
    ...overrides,
  };
}

function byteBackedVisualOracleArtifacts(overrides = {}) {
  return visualOracleArtifacts({
    before_image: VISUAL_BEFORE.path,
    beforeImage: VISUAL_BEFORE.path,
    before_image_hash: VISUAL_BEFORE.hash,
    beforeImageHash: VISUAL_BEFORE.hash,
    after_image: VISUAL_AFTER.path,
    afterImage: VISUAL_AFTER.path,
    after_image_hash: VISUAL_AFTER.hash,
    afterImageHash: VISUAL_AFTER.hash,
    diff_image: VISUAL_DIFF.path,
    diffImage: VISUAL_DIFF.path,
    diff_image_hash: VISUAL_DIFF.hash,
    diffImageHash: VISUAL_DIFF.hash,
    swapchain_size: [2, 2],
    swapchainSize: [2, 2],
    visual_pixel_verification: {
      before_image_hash: VISUAL_BEFORE.hash,
      after_image_hash: VISUAL_AFTER.hash,
      diff_image_hash: VISUAL_DIFF.hash,
      before_image_hash_verified: true,
      after_image_hash_verified: true,
      diff_image_hash_verified: true,
      metrics_verified: true,
    },
    ...overrides,
  });
}

function casOnlyVisualOracleArtifacts(overrides = {}) {
  const artifactCasLocators = overrides.artifactCasLocators
    ?? overrides.artifact_cas_locators
    ?? [VISUAL_BEFORE_CAS, VISUAL_AFTER_CAS, VISUAL_DIFF_CAS];
  return visualOracleArtifacts({
    before_image: null,
    beforeImage: null,
    before_image_hash: VISUAL_BEFORE.hash,
    beforeImageHash: VISUAL_BEFORE.hash,
    after_image: null,
    afterImage: null,
    after_image_hash: VISUAL_AFTER.hash,
    afterImageHash: VISUAL_AFTER.hash,
    diff_image: null,
    diffImage: null,
    diff_image_hash: VISUAL_DIFF.hash,
    diffImageHash: VISUAL_DIFF.hash,
    swapchain_size: [2, 2],
    swapchainSize: [2, 2],
    visual_pixel_verification: {
      before_image_hash: VISUAL_BEFORE.hash,
      after_image_hash: VISUAL_AFTER.hash,
      diff_image_hash: VISUAL_DIFF.hash,
      before_image_hash_verified: true,
      after_image_hash_verified: true,
      diff_image_hash_verified: true,
      metrics_verified: true,
    },
    ...overrides,
    artifactCasLocators,
    artifact_cas_locators: artifactCasLocators,
  });
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
      backend: 'hip',
      device_uuid: 'hip-device:gfx1201:1:0',
      gpu_arch: 'gfx1201',
      compile_target: 'gfx1201',
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

function computeOracleArtifactsWithoutBytes() {
  const copy = JSON.parse(JSON.stringify(computeOracleArtifacts()));
  copy.raw_readback_bin = 'memory://strict-readback-after.bin';
  copy.rawReadbackBin = 'memory://strict-readback-after.bin';
  return copy;
}

function withComputeOracleProofLedgerOnly(computeOracleArtifactsValue) {
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord({
    oracle_artifacts: {
      compute_oracle_artifacts: computeOracleArtifactsValue,
    },
  }));
  assert.equal(proofLedger.query.gpuHmrSuccess, true);
  return {
    proofLedger,
    proofLedgerQuery: proofLedger.query,
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

function installCaptureEvidenceBinding(captureManifest, binding) {
  const bindingHash = contentHash(binding);
  captureManifest.evidence_binding = structuredClone(binding);
  captureManifest.evidence_binding_hash = bindingHash;
  captureManifest.frame_gate.evidence_binding = structuredClone(binding);
  captureManifest.frame_gate.evidence_binding_hash = bindingHash;
}

function boundVisualLedgerRecord(overrides = {}) {
  const record = visualLedgerRecord({
    runtime_proof_id: `gpu-runtime-proof:${HASH_C}`,
    runtime_proof_state: 'gpu-hmr-full-runtime-proven',
    runtime_proof_accepted: true,
    runtime_proof_observed_at_ms: 1_100,
    hmr_observed_at_ms: 1_000,
    runtime_session_id: 'runtime-session-1',
    ...overrides,
  });
  record.output_event.output_target ??= 'render-target-1';
  for (const event of [
    record.loader_event,
    record.epoch_publish_event,
    record.dispatch_event,
    record.output_event,
  ]) {
    event.runtime_session_id ??= record.runtime_session_id;
    event.device_uuid ??= record.device_identity.device_uuid;
  }
  record.process_identity.runtime_session_id ??= record.runtime_session_id;

  const artifacts = record.oracle_artifacts.visual_oracle_artifacts;
  const [width, height] = artifacts.swapchain_size ?? artifacts.swapchainSize;
  const afterImageHash = artifacts.after_image_hash ?? artifacts.afterImageHash;
  const gateToken = 'frame-gate:strict-visual-proof';
  const evidenceBinding = buildGpuHmrFrameGateRuntimeBinding(record);
  artifacts.capture_manifest = {
    schema_version: 'synthi.mcp.capture_manifest.v1',
    session_id: 'strict-preview-session-1',
    capture_backend: artifacts.capture_backend ?? artifacts.captureBackend,
    capture_event_id: 'screenshot:strict-preview-session-1:12:1500',
    frame_event_id: 'broker-frame:strict-preview-session-1:12',
    frame_seq: 12,
    frame_ts_ms: 1_400,
    capture_ts_ms: 1_500,
    source_frame_hash: afterImageHash,
    broker_frame_hash: afterImageHash,
    image_sha256: afterImageHash,
    image_byte_length: readFileSync(VISUAL_AFTER.path).length,
    width,
    height,
    gate_token: gateToken,
    gate_token_verified: true,
    required_frame_seq: 11,
    required_ts_ms: 1_200,
    frame_gate: {
      status: 'satisfied',
      required_frame_seq: 11,
      required_ts_ms: 1_200,
      gate_token: gateToken,
      gate_token_verified: true,
      gate_token_issued_at_ms: 1_300,
      gate_token_expires_at_ms: 2_000,
      session_id: 'strict-preview-session-1',
      captured_frame_seq: 12,
      captured_ts_ms: 1_400,
      timeout_ms: 120_000,
    },
  };
  installCaptureEvidenceBinding(artifacts.capture_manifest, evidenceBinding);
  artifacts.visual_capture_runtime_binding = buildGpuHmrVisualCaptureRuntimeBinding(record);
  return record;
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
  const hardwareTargetEvidence = {
    schemaVersion: 'synthi.gpu_hmr.hip_module_hardware_target_evidence.v1',
    accepted: true,
    backend: 'hip',
    gpuArch: 'gfx1201',
    gpu_arch: 'gfx1201',
    compileTarget: 'gfx1201',
    compile_target: 'gfx1201',
    deviceUuid: 'hip-device:gfx1201:1:0',
    device_uuid: 'hip-device:gfx1201:1:0',
    evidenceRefs: ['runtime:hip-module:device:hip-device:gfx1201:1:0'],
    evidence_refs: ['runtime:hip-module:device:hip-device:gfx1201:1:0'],
    failedGates: [],
    failed_gates: [],
  };
  return {
    proofId: 'hip-module-runtime-proof-artifact:proof-pass',
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
    hardwareTargetEvidence,
    hardware_target_evidence: hardwareTargetEvidence,
    ...overrides,
  };
}

const passingArtifact = runtimeArtifact();
const webgpuComputeOnlyLedger = buildGpuHmrProofLedger(ledgerRecord({
  backend: 'webgpu',
  output_event: {
    id: 'output-webgpu-compute-1',
    kind: 'compute_readback',
    epoch: 'epoch-7',
    artifact_hash: HASH_B,
    process_id: 'pid-1',
    after_dispatch_id: 'dispatch-1',
    passed: true,
    timestamp_monotonic_ns: 400,
  },
  output_oracle_target: {
    kind: 'compute',
    target_id: 'storage-buffer-1',
    compute_only_target_verified: true,
    evidence_refs: ['runtime:webgpu-compute-readback'],
  },
}));
const byteBackedVisualLedger = buildGpuHmrProofLedger(boundVisualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: byteBackedVisualOracleArtifacts(),
  },
}));
const byteBackedVisualArtifact = runtimeArtifact({
  proofId: 'strict-visual-runtime-proof-artifact:byte-backed-pass',
  proofLedger: byteBackedVisualLedger,
  proofLedgerQuery: byteBackedVisualLedger.query,
  deterministicVisualModeEvaluation: { accepted: true },
});
const casOnlyVisualLedger = buildGpuHmrProofLedger(boundVisualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: casOnlyVisualOracleArtifacts(),
  },
}));
const casOnlyVisualOverlay = [{
  before_image: VISUAL_BEFORE_CAS.storage.localPath,
  beforeImage: VISUAL_BEFORE_CAS.storage.localPath,
  after_image: VISUAL_AFTER_CAS.storage.localPath,
  afterImage: VISUAL_AFTER_CAS.storage.localPath,
  diff_image: VISUAL_DIFF_CAS.storage.localPath,
  diffImage: VISUAL_DIFF_CAS.storage.localPath,
  proofAuthority: 'resolved_visual_artifact_overlay_transport_integrity_only',
  proof_authority: 'resolved_visual_artifact_overlay_transport_integrity_only',
  acceptedForGpuHmr: false,
  accepted_for_gpu_hmr: false,
  gpuHmrSuccess: false,
  gpu_hmr_success: false,
}];
const casOnlyVisualQuery = queryGpuHmrLedgerInvariants(casOnlyVisualLedger, {
  visualOracleArtifactOverlays: casOnlyVisualOverlay,
  ignoreSuppliedLedgerQueryAndSuccess: true,
});
const casOnlyVisualArtifact = runtimeArtifact({
  proofId: 'strict-visual-runtime-proof-artifact:cas-only-pass',
  proofLedger: casOnlyVisualLedger,
  proofLedgerQuery: casOnlyVisualQuery,
  deterministicVisualModeEvaluation: { accepted: true },
});

assert.equal(adversarialPreflightStrictGate(passingPreflight).status, 'pass');
assert.equal(runtimeProofArtifactStrictGate(passingArtifact).status, 'pass');
assert.equal(runtimeProofArtifactStrictGate(runtimeArtifact({
  proofLedger: webgpuComputeOnlyLedger,
  proofLedgerQuery: webgpuComputeOnlyLedger.query,
})).status, 'pass');
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-compute-runtime-proof-artifact:declaration-only-refused',
    ...withComputeOracleProofLedgerOnly(computeOracleArtifactsWithoutBytes()),
  })).detail,
  /compute_oracle_raw_readback_bytes_unreadable/,
);
assert.equal(runtimeProofArtifactStrictGate(byteBackedVisualArtifact).status, 'pass');
const strippedVisualBindingArtifact = structuredClone(byteBackedVisualArtifact);
const strippedVisualBindingArtifacts = strippedVisualBindingArtifact
  .proofLedger.records[0].oracleArtifacts.visual_oracle_artifacts;
assert.ok(strippedVisualBindingArtifacts.visual_capture_runtime_binding);
delete strippedVisualBindingArtifacts.visual_capture_runtime_binding;
const strippedVisualBindingQuery = queryGpuHmrLedgerInvariants(
  strippedVisualBindingArtifact.proofLedger,
  { requireVisualCaptureRuntimeBinding: true },
);
assert.equal(strippedVisualBindingQuery.gpuHmrSuccess, false);
assert.ok(strippedVisualBindingQuery.failedInvariants.some(
  (failure) => failure.code === 'visual_capture_runtime_binding_missing',
));
assert.notEqual(strippedVisualBindingQuery.proofId, byteBackedVisualLedger.proofId);
const strippedVisualBindingGate = runtimeProofArtifactStrictGate(strippedVisualBindingArtifact);
assert.equal(strippedVisualBindingGate.status, 'fail');
assert.match(
  strippedVisualBindingGate.detail,
  /proof_ledger_recomputed_query_rejected/,
);
const casOnlyStrictGate = runtimeProofArtifactStrictGate(casOnlyVisualArtifact, {
  visualArtifactRoots: [SELF_CHECK_CAS_ROOT],
});
assert.equal(
  casOnlyStrictGate.status,
  'pass',
  `${casOnlyStrictGate.detail} cas_query=${JSON.stringify(casOnlyVisualQuery.failedInvariants)}`,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...casOnlyVisualArtifact,
    proofId: 'strict-visual-runtime-proof-artifact:cas-only-stale-query-refused',
    proofLedgerQuery: casOnlyVisualLedger.query,
  }, { visualArtifactRoots: [SELF_CHECK_CAS_ROOT] }).detail,
  /proof_ledger_query_(mismatch|rejected)/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...casOnlyVisualArtifact,
    proofId: 'strict-visual-runtime-proof-artifact:cas-only-false-query-refused',
    proofLedgerQuery: { gpuHmrSuccess: false, failedInvariants: [] },
  }, { visualArtifactRoots: [SELF_CHECK_CAS_ROOT] }).detail,
  /proof_ledger_query_(mismatch|rejected)/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...casOnlyVisualArtifact,
    proofId: 'strict-visual-runtime-proof-artifact:cas-only-forged-query-refused',
    proofLedgerQuery: { gpuHmrSuccess: true, failedInvariants: [{ code: 'forged' }] },
  }, { visualArtifactRoots: [SELF_CHECK_CAS_ROOT] }).detail,
  /proof_ledger_query_mismatch/,
);
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
    hardwareTargetEvidence: null,
    hardware_target_evidence: null,
  }).detail,
  /hip_module_hardware_target_evidence_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    hardwareTargetEvidence: {
      ...passingArtifact.hardwareTargetEvidence,
      accepted: false,
      gpuArch: null,
      gpu_arch: null,
      compileTarget: 'rocm-default',
      compile_target: 'rocm-default',
    },
    hardware_target_evidence: {
      ...passingArtifact.hardware_target_evidence,
      accepted: false,
      gpuArch: null,
      gpu_arch: null,
      compileTarget: 'rocm-default',
      compile_target: 'rocm-default',
    },
  }).detail,
  /hip_module_hardware_gfx_arch_missing/,
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
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:descriptor-only-refused',
    proofLedger: buildGpuHmrProofLedger(visualLedgerRecord()),
    proofLedgerQuery: buildGpuHmrProofLedger(visualLedgerRecord()).query,
    deterministicVisualModeEvaluation: { accepted: true },
  })).detail,
  /visual_oracle_before_image_bytes_unreadable/,
);
const invalidPngLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: byteBackedVisualOracleArtifacts({
      before_image: VISUAL_INVALID.path,
      beforeImage: VISUAL_INVALID.path,
      before_image_hash: VISUAL_INVALID.hash,
      beforeImageHash: VISUAL_INVALID.hash,
      visual_pixel_verification: {
        before_image_hash: VISUAL_INVALID.hash,
        after_image_hash: VISUAL_AFTER.hash,
        diff_image_hash: VISUAL_DIFF.hash,
        before_image_hash_verified: true,
        after_image_hash_verified: true,
        diff_image_hash_verified: true,
        metrics_verified: true,
      },
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:invalid-png-refused',
    proofLedger: invalidPngLedger,
    proofLedgerQuery: invalidPngLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  })).detail,
  /visual_oracle_before_image_png_invalid/,
);
const corruptPngLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: byteBackedVisualOracleArtifacts({
      before_image: VISUAL_CORRUPT.path,
      beforeImage: VISUAL_CORRUPT.path,
      before_image_hash: VISUAL_CORRUPT.hash,
      beforeImageHash: VISUAL_CORRUPT.hash,
      visual_pixel_verification: {
        before_image_hash: VISUAL_CORRUPT.hash,
        after_image_hash: VISUAL_AFTER.hash,
        diff_image_hash: VISUAL_DIFF.hash,
        before_image_hash_verified: true,
        after_image_hash_verified: true,
        diff_image_hash_verified: true,
        metrics_verified: true,
      },
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:corrupt-png-refused',
    proofLedger: corruptPngLedger,
    proofLedgerQuery: corruptPngLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  })).detail,
  /visual_oracle_before_image_png_invalid/,
);
const mismatchedDimensionsLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: byteBackedVisualOracleArtifacts({
      swapchain_size: [640, 480],
      swapchainSize: [640, 480],
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:dimension-mismatch-refused',
    proofLedger: mismatchedDimensionsLedger,
    proofLedgerQuery: mismatchedDimensionsLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  })).detail,
  /visual_oracle_before_image_dimensions_mismatch/,
);
const duplicateBeforeAfterLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: byteBackedVisualOracleArtifacts({
      after_image: VISUAL_BEFORE.path,
      afterImage: VISUAL_BEFORE.path,
      after_image_hash: VISUAL_BEFORE.hash,
      afterImageHash: VISUAL_BEFORE.hash,
      visual_pixel_verification: {
        before_image_hash: VISUAL_BEFORE.hash,
        after_image_hash: VISUAL_BEFORE.hash,
        diff_image_hash: VISUAL_DIFF.hash,
        before_image_hash_verified: true,
        after_image_hash_verified: true,
        diff_image_hash_verified: true,
        metrics_verified: true,
      },
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:duplicate-before-after-refused',
    proofLedger: duplicateBeforeAfterLedger,
    proofLedgerQuery: duplicateBeforeAfterLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  })).detail,
  /visual_oracle_before_after_image_hashes_not_distinct/,
);
const duplicateDiffLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: byteBackedVisualOracleArtifacts({
      diff_image: VISUAL_AFTER.path,
      diffImage: VISUAL_AFTER.path,
      diff_image_hash: VISUAL_AFTER.hash,
      diffImageHash: VISUAL_AFTER.hash,
      visual_pixel_verification: {
        before_image_hash: VISUAL_BEFORE.hash,
        after_image_hash: VISUAL_AFTER.hash,
        diff_image_hash: VISUAL_AFTER.hash,
        before_image_hash_verified: true,
        after_image_hash_verified: true,
        diff_image_hash_verified: true,
        metrics_verified: true,
      },
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:duplicate-diff-refused',
    proofLedger: duplicateDiffLedger,
    proofLedgerQuery: duplicateDiffLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  })).detail,
  /visual_oracle_diff_image_hash_not_distinct/,
);
const successClaimCasLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: casOnlyVisualOracleArtifacts({
      artifactCasLocators: [
        { ...VISUAL_BEFORE_CAS, acceptedForGpuHmr: true },
        VISUAL_AFTER_CAS,
        VISUAL_DIFF_CAS,
      ],
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:success-claim-cas-refused',
    proofLedger: successClaimCasLedger,
    proofLedgerQuery: successClaimCasLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  }), { visualArtifactRoots: [SELF_CHECK_CAS_ROOT] }).detail,
  /visual_oracle_before_image_cas_locator_invalid/,
);
const duplicateSuccessClaimCasLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: casOnlyVisualOracleArtifacts({
      artifactCasLocators: [
        VISUAL_BEFORE_CAS,
        { ...VISUAL_BEFORE_CAS, acceptedForGpuHmr: true },
        VISUAL_AFTER_CAS,
        VISUAL_DIFF_CAS,
      ],
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:duplicate-success-claim-cas-refused',
    proofLedger: duplicateSuccessClaimCasLedger,
    proofLedgerQuery: duplicateSuccessClaimCasLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  }), { visualArtifactRoots: [SELF_CHECK_CAS_ROOT] }).detail,
  /visual_oracle_artifact_cas_locator_invalid/,
);
const wrongSchemaSuccessClaimCasLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: casOnlyVisualOracleArtifacts({
      artifactCasLocators: [
        VISUAL_BEFORE_CAS,
        {
          ...VISUAL_BEFORE_CAS,
          schemaVersion: 'synthi.cas.artifact_locator.v0',
          acceptedForGpuHmr: true,
          manifestHash: undefined,
        },
        VISUAL_AFTER_CAS,
        VISUAL_DIFF_CAS,
      ],
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:wrong-schema-success-claim-cas-refused',
    proofLedger: wrongSchemaSuccessClaimCasLedger,
    proofLedgerQuery: wrongSchemaSuccessClaimCasLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  }), { visualArtifactRoots: [SELF_CHECK_CAS_ROOT] }).detail,
  /visual_oracle_artifact_cas_locator_invalid/,
);
const wrongByteLengthCasLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: casOnlyVisualOracleArtifacts({
      artifactCasLocators: [
        {
          ...VISUAL_BEFORE_CAS,
          byteLength: VISUAL_BEFORE_CAS.byteLength + 1,
          manifestHash: undefined,
        },
        VISUAL_AFTER_CAS,
        VISUAL_DIFF_CAS,
      ],
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:wrong-byte-length-cas-refused',
    proofLedger: wrongByteLengthCasLedger,
    proofLedgerQuery: wrongByteLengthCasLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  }), { visualArtifactRoots: [SELF_CHECK_CAS_ROOT] }).detail,
  /visual_oracle_before_image_cas_locator_invalid/,
);
const wrongUriCasLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: casOnlyVisualOracleArtifacts({
      artifactCasLocators: [
        {
          ...VISUAL_BEFORE_CAS,
          artifactUri: `synthi-cas://strict_gates/sha256/${VISUAL_AFTER.hash.slice('sha256:'.length)}`,
          manifestHash: undefined,
        },
        VISUAL_AFTER_CAS,
        VISUAL_DIFF_CAS,
      ],
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:wrong-uri-cas-refused',
    proofLedger: wrongUriCasLedger,
    proofLedgerQuery: wrongUriCasLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  }), { visualArtifactRoots: [SELF_CHECK_CAS_ROOT] }).detail,
  /visual_oracle_before_image_cas_locator_invalid/,
);
const forgedHashCasLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: casOnlyVisualOracleArtifacts({
      before_image_hash: VISUAL_AFTER.hash,
      beforeImageHash: VISUAL_AFTER.hash,
      artifactCasLocators: [
        {
          ...VISUAL_BEFORE_CAS,
          contentHash: VISUAL_AFTER.hash,
          artifactId: `artifact:${VISUAL_AFTER.hash}`,
          manifestHash: undefined,
        },
        VISUAL_AFTER_CAS,
        VISUAL_DIFF_CAS,
      ],
      visual_pixel_verification: {
        before_image_hash: VISUAL_AFTER.hash,
        after_image_hash: VISUAL_AFTER.hash,
        diff_image_hash: VISUAL_DIFF.hash,
        before_image_hash_verified: true,
        after_image_hash_verified: true,
        diff_image_hash_verified: true,
        metrics_verified: true,
      },
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:forged-hash-cas-refused',
    proofLedger: forgedHashCasLedger,
    proofLedgerQuery: forgedHashCasLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  }), { visualArtifactRoots: [SELF_CHECK_CAS_ROOT] }).detail,
  /visual_oracle_before_image_cas_locator_invalid/,
);
const forgedVisualLedger = buildGpuHmrProofLedger(visualLedgerRecord({
  oracle_artifacts: {
    visual_oracle_artifacts: byteBackedVisualOracleArtifacts({
      after_image_hash: VISUAL_BEFORE.hash,
      afterImageHash: VISUAL_BEFORE.hash,
      visual_pixel_verification: {
        before_image_hash: VISUAL_BEFORE.hash,
        after_image_hash: VISUAL_BEFORE.hash,
        diff_image_hash: VISUAL_DIFF.hash,
        before_image_hash_verified: true,
        after_image_hash_verified: true,
        diff_image_hash_verified: true,
        metrics_verified: true,
      },
    }),
  },
}));
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofId: 'strict-visual-runtime-proof-artifact:hash-mismatch-refused',
    proofLedger: forgedVisualLedger,
    proofLedgerQuery: forgedVisualLedger.query,
    deterministicVisualModeEvaluation: { accepted: true },
  })).detail,
  /visual_oracle_after_image_hash_mismatch/,
);
assert.match(
  runtimeProofArtifactStrictGates([], { requireAtLeastOne: true })[0].detail,
  /runtime_proof_artifact_missing/,
);
assert.equal(runtimeProofArtifactStrictGates([], { requireAtLeastOne: false }).length, 0);

console.log('gpu-hmr proof strict gates self-check passed');
