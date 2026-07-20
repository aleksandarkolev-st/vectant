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
  GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
  queryGpuHmrLedgerInvariants,
} from './lib/gpu-hmr-proof-ledger.mjs';
import {
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
  GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
  recomputeGpuHmrAcceptanceContractHash,
} from './lib/gpu-hmr-acceptance-contract.mjs';
import { writeArtifactToCas } from './lib/gpu-hmr-artifact-cas.mjs';
import { buildComputeExpectedOutputContract } from './lib/gpu-hmr-compute-oracle-semantics.mjs';
import {
  buildValidationRuntimeProofArtifact,
  computeOracleArtifactsFromFiles,
  verifyComputeOracleArtifactBundle,
  visualEvidenceArtifactsFromFiles,
  visualEvidenceArtifactsFromVisualOracleArtifacts,
  visualOracleArtifactsFromFiles,
  writeValidationRuntimeProofArtifact,
} from './lib/gpu-hmr-validation-proof-artifact.mjs';

const HASH_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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

const ORACLE_IMPLEMENTATION_BYTES = Buffer.from(
  'export function verify(values) { return values.every(Number.isFinite); }\n',
  'utf8',
);
const ORACLE_IMPLEMENTATION_PATH = path.join(
  SELF_CHECK_ARTIFACT_DIR,
  'strict-compute-oracle-implementation.mjs',
);
writeFileSync(ORACLE_IMPLEMENTATION_PATH, ORACLE_IMPLEMENTATION_BYTES);
const HASH_C = sha256Bytes(ORACLE_IMPLEMENTATION_BYTES);

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
const COMPUTE_EXPECTED_VALUES = [4, 8, 15, 16, 23, 42, 64, 128];
const COMPUTE_RAW_BYTES = Buffer.alloc(COMPUTE_EXPECTED_VALUES.length * 4);
COMPUTE_EXPECTED_VALUES.forEach((value, index) => {
  COMPUTE_RAW_BYTES.writeFloatLE(value, index * 4);
});
const COMPUTE_RAW_PATH = path.join(SELF_CHECK_ARTIFACT_DIR, 'strict-readback-after.bin');
writeFileSync(COMPUTE_RAW_PATH, COMPUTE_RAW_BYTES);
const COMPUTE_RAW_HASH = sha256Bytes(COMPUTE_RAW_BYTES);
const COMPUTE_SLICE_BYTES = COMPUTE_RAW_BYTES;
const COMPUTE_SLICE_HASH = sha256Bytes(COMPUTE_SLICE_BYTES);
const COMPUTE_SCHEMA_PATH = path.join(SELF_CHECK_ARTIFACT_DIR, 'strict-readback-schema.json');
const COMPUTE_SCHEMA = {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
  dataType: 'float32',
  byteLength: COMPUTE_RAW_BYTES.length,
  elementCount: COMPUTE_EXPECTED_VALUES.length,
  shape: [COMPUTE_EXPECTED_VALUES.length],
  byteOrder: 'little_endian',
  rawReadbackHash: COMPUTE_RAW_HASH,
  deterministicSlice: {
    offset: 0,
    length: COMPUTE_RAW_BYTES.length,
    hash: COMPUTE_SLICE_HASH,
  },
  expectedOutput: {
    dataType: 'float32',
    values: COMPUTE_EXPECTED_VALUES,
    tolerance: 0,
  },
};
writeFileSync(COMPUTE_SCHEMA_PATH, `${JSON.stringify(COMPUTE_SCHEMA, null, 2)}\n`);
const COMPUTE_SCHEMA_HASH = sha256Bytes(readFileSync(COMPUTE_SCHEMA_PATH));
const EXPLICIT_COMPUTE_ROOT = path.join(SELF_CHECK_ARTIFACT_DIR, 'explicit-compute-root');
const EXPLICIT_COMPUTE_CAS_ROOT = path.join(EXPLICIT_COMPUTE_ROOT, 'cas');
const EXPLICIT_COMPUTE_RAW_PATH = path.join(EXPLICIT_COMPUTE_ROOT, 'readback.bin');
const EXPLICIT_COMPUTE_SCHEMA_PATH = path.join(EXPLICIT_COMPUTE_ROOT, 'readback-schema.json');
const EXPLICIT_ORACLE_IMPLEMENTATION_PATH = path.join(
  EXPLICIT_COMPUTE_ROOT,
  'oracle-implementation.mjs',
);
mkdirSync(EXPLICIT_COMPUTE_ROOT, { recursive: true });
mkdirSync(EXPLICIT_COMPUTE_CAS_ROOT, { recursive: true });
writeFileSync(EXPLICIT_COMPUTE_RAW_PATH, COMPUTE_RAW_BYTES);
writeFileSync(EXPLICIT_COMPUTE_SCHEMA_PATH, readFileSync(COMPUTE_SCHEMA_PATH));
writeFileSync(EXPLICIT_ORACLE_IMPLEMENTATION_PATH, ORACLE_IMPLEMENTATION_BYTES);

function computeExpectedOutputContract(overrides = {}) {
  return buildComputeExpectedOutputContract({
    comparisonMode: 'numeric_tolerance',
    dtype: 'float32',
    shape: [COMPUTE_EXPECTED_VALUES.length],
    elementCount: COMPUTE_EXPECTED_VALUES.length,
    byteOrder: 'little_endian',
    tolerance: 0,
    expectedValues: COMPUTE_EXPECTED_VALUES,
    binding: {
      projectId: 'strict-generic-gpu-project',
      editId: 'gpu-artifact-edit',
      artifactAfterHash: HASH_B,
      outputTargetId: 'allocation-1',
      oracleCodeHash: HASH_C,
    },
    evidenceRefs: ['contract:pre-dispatch:strict-compute-output'],
    ...overrides,
  });
}

const COMPUTE_EXPECTED_OUTPUT_CONTRACT = computeExpectedOutputContract();

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

async function computeCasLocator(
  bytes,
  role,
  artifactKind,
  mediaType,
  artifactRoot = SELF_CHECK_CAS_ROOT,
) {
  return writeArtifactToCas(bytes, {
    artifactRoot,
    artifactKind,
    mediaType,
    role,
    producer: {
      name: 'strict_gates_self_check',
      kind: 'compute_proof_worker',
    },
    producerSubsystem: 'strict_compute_self_check',
    sessionNamespace: 'strict_gates',
    transportKind: 'cas_shared_volume',
  });
}

function locatorWithoutManifestHash(locator, overrides = {}) {
  const copy = { ...locator, ...overrides };
  delete copy.manifestHash;
  delete copy.manifest_hash;
  return copy;
}

const VISUAL_BEFORE_CAS = await visualCasLocator(VISUAL_BEFORE, 'before_frame');
const VISUAL_AFTER_CAS = await visualCasLocator(VISUAL_AFTER, 'after_frame');
const VISUAL_DIFF_CAS = await visualCasLocator(VISUAL_DIFF, 'diff_frame');
const ORACLE_IMPLEMENTATION_CAS = await computeCasLocator(
  ORACLE_IMPLEMENTATION_BYTES,
  'oracle_implementation',
  'compute_oracle_implementation',
  'text/javascript',
);
const EXPLICIT_ORACLE_IMPLEMENTATION_CAS = await computeCasLocator(
  ORACLE_IMPLEMENTATION_BYTES,
  'oracle_implementation',
  'compute_oracle_implementation',
  'text/javascript',
  EXPLICIT_COMPUTE_CAS_ROOT,
);
const FORGED_ORACLE_IMPLEMENTATION_CAS = await computeCasLocator(
  Buffer.from('export function verify() { return true; }\n', 'utf8'),
  'oracle_implementation',
  'compute_oracle_implementation',
  'text/javascript',
);

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

function computeOracleArtifacts(overrides = {}) {
  return {
    raw_readback_bin: COMPUTE_RAW_PATH,
    readback_schema_json: COMPUTE_SCHEMA_PATH,
    checksum_before: HASH_A,
    checksum_after: COMPUTE_RAW_HASH,
    expected_output_change: true,
    deterministic_slice: {
      offset: 0,
      length: COMPUTE_RAW_BYTES.length,
      format: 'float32',
      hash: COMPUTE_SLICE_HASH,
    },
    raw_readback_hash: COMPUTE_RAW_HASH,
    raw_readback_hash_verified: true,
    raw_readback_byte_length: COMPUTE_RAW_BYTES.length,
    readback_schema_hash: COMPUTE_SCHEMA_HASH,
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
    semantic_oracle_implementation_hash: HASH_C,
    oracle_implementation_artifact: {
      schemaVersion: 'synthi.gpu_hmr.oracle_implementation_artifact.v1',
      role: 'oracle_implementation',
      path: ORACLE_IMPLEMENTATION_PATH,
      content_hash: HASH_C,
      byte_length: ORACLE_IMPLEMENTATION_BYTES.length,
    },
    rendered_card_png: 'memory://strict-compute-oracle-card.png',
    producer: 'strict-gates-self-check',
    timestamp_after_dispatch: 400,
    epoch: 'epoch-7',
    ...overrides,
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
    schema_version: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
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
      output_target_id: 'allocation-1',
      oracle_code_hash: HASH_C,
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
    output_oracle_target: {
      kind: 'compute',
      target_id: 'allocation-1',
      compute_only_target_verified: true,
      evidence_refs: ['runtime:compute-readback'],
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
  const contract = {
    contract_version: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
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
        expected_output_contract: COMPUTE_EXPECTED_OUTPUT_CONTRACT,
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
  contract.contract_hash = recomputeGpuHmrAcceptanceContractHash(contract);
  return contract;
}

function runtimeArtifact(overrides = {}) {
  const contract = acceptanceContract();
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord({
    contract_hash: contract.contract_hash,
  }));
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: contract,
    derivedContract: contract,
    derivedEvaluation: contractEvaluation,
  });
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
    acceptanceContractConsistency: contractConsistency,
    hardwareTargetEvidence,
    hardware_target_evidence: hardwareTargetEvidence,
    ...overrides,
  };
}

function acceptanceContractWithOutputOracle(outputOracleContract) {
  const contract = acceptanceContract();
  contract.fission_report = {
    ...contract.fission_report,
    output_oracle_contract: outputOracleContract,
  };
  contract.contract_hash = recomputeGpuHmrAcceptanceContractHash(contract);
  return contract;
}

function visualAcceptanceContract() {
  return acceptanceContractWithOutputOracle({
    kind: 'render_target_hash',
    output_target_id: 'render-target-1',
    readback_plan: 'after-dispatch',
  });
}

function runtimeArtifactForContract(contract, recordOverrides = {}) {
  const proofLedger = buildGpuHmrProofLedger(ledgerRecord({
    contract_hash: contract.contract_hash,
    ...recordOverrides,
  }));
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: contract,
    derivedContract: contract,
    derivedEvaluation: contractEvaluation,
  });
  assert.equal(proofLedger.query.gpuHmrSuccess, true);
  assert.equal(contractEvaluation.accepted, true);
  return runtimeArtifact({
    proofLedger,
    proofLedgerQuery: proofLedger.query,
    acceptanceContract: contract,
    acceptanceContractEvaluation: contractEvaluation,
    acceptanceContractConsistency: contractConsistency,
  });
}

function runtimeArtifactForLedgerAndContract(contract, proofLedger, overrides = {}) {
  const contractEvaluation = evaluateGpuHmrAcceptanceContract(contract);
  const contractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: contract,
    derivedContract: contract,
    derivedEvaluation: contractEvaluation,
  });
  return runtimeArtifact({
    proofLedger,
    proofLedgerQuery: proofLedger.query,
    acceptanceContract: contract,
    acceptanceContractEvaluation: contractEvaluation,
    acceptanceContractConsistency: contractConsistency,
    ...overrides,
  });
}

function runtimeArtifactForExpectedOutputContract(expectedOutputContract) {
  return runtimeArtifactForContract(acceptanceContractWithOutputOracle({
    kind: 'buffer_checksum',
    output_target_id: 'allocation-1',
    readback_plan: 'after-dispatch',
    expected_output_contract: expectedOutputContract,
  }));
}

function assertStrictSemanticRejection(artifact, expectedFailure) {
  assert.equal(artifact.proofLedgerQuery.gpuHmrSuccess, true);
  assert.equal(artifact.acceptanceContractEvaluation.accepted, true);
  const gate = runtimeProofArtifactStrictGate(artifact);
  assert.equal(gate.status, 'fail', gate.detail);
  assert.match(gate.detail, expectedFailure);
}

function proofLedgerFromRecords(records) {
  const ledger = {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    records: structuredClone(records),
  };
  const query = queryGpuHmrLedgerInvariants(ledger);
  return {
    ...ledger,
    proofId: query.proofId,
    query,
    gpuHmrSuccess: query.gpuHmrSuccess,
    gpu_hmr_success: query.gpuHmrSuccess,
  };
}

const passingArtifact = runtimeArtifact();
const unexpectedValuesArtifact = runtimeArtifactForExpectedOutputContract(
  computeExpectedOutputContract({
    expectedValues: COMPUTE_EXPECTED_VALUES.map((value) => value + 1),
  }),
);
const reboundTargetArtifact = runtimeArtifactForExpectedOutputContract(
  computeExpectedOutputContract({
    binding: {
      projectId: 'strict-generic-gpu-project',
      editId: 'gpu-artifact-edit',
      artifactAfterHash: HASH_B,
      outputTargetId: 'allocation-2',
      oracleCodeHash: HASH_C,
    },
  }),
);
const reboundOracleImplementationArtifact = runtimeArtifactForExpectedOutputContract(
  computeExpectedOutputContract({
    binding: {
      projectId: 'strict-generic-gpu-project',
      editId: 'gpu-artifact-edit',
      artifactAfterHash: HASH_B,
      outputTargetId: 'allocation-1',
      oracleCodeHash: HASH_A,
    },
  }),
);
const conflictingExpectedOutputAliasArtifact = runtimeArtifactForContract(
  acceptanceContractWithOutputOracle({
    kind: 'buffer_checksum',
    output_target_id: 'allocation-1',
    readback_plan: 'after-dispatch',
    expected_output_contract: COMPUTE_EXPECTED_OUTPUT_CONTRACT,
    expectedOutputContract: computeExpectedOutputContract({
      expectedValues: COMPUTE_EXPECTED_VALUES.map((value) => value + 2),
    }),
  }),
);
const reboundSliceArtifacts = computeOracleArtifacts();
const reboundSliceBytes = COMPUTE_RAW_BYTES.subarray(4);
const reboundSliceHash = sha256Bytes(reboundSliceBytes);
reboundSliceArtifacts.deterministic_slice = {
  ...reboundSliceArtifacts.deterministic_slice,
  offset: 4,
  length: reboundSliceBytes.length,
  hash: reboundSliceHash,
};
reboundSliceArtifacts.deterministic_slice_hash = reboundSliceHash;
reboundSliceArtifacts.raw_readback_verification = {
  ...reboundSliceArtifacts.raw_readback_verification,
  deterministic_slice_hash: reboundSliceHash,
};
const reboundSliceArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: reboundSliceArtifacts,
    },
  },
);
const missingRuntimeTargetOutputEvent = {
  ...ledgerRecord().output_event,
};
delete missingRuntimeTargetOutputEvent.output_target_id;
const missingRuntimeTarget = {
  ...ledgerRecord().output_oracle_target,
};
delete missingRuntimeTarget.target_id;
const missingRuntimeTargetArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    output_event: missingRuntimeTargetOutputEvent,
    output_oracle_target: missingRuntimeTarget,
  },
);
const missingSchemaHashArtifacts = computeOracleArtifacts();
delete missingSchemaHashArtifacts.readback_schema_hash;
const missingSchemaHashArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: missingSchemaHashArtifacts,
    },
  },
);
const mixedVisualComputeArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: computeOracleArtifacts(),
      visual_oracle_artifacts: byteBackedVisualOracleArtifacts(),
    },
    deterministic_visual_mode: deterministicVisualMode(),
  },
);
const selfDeclaredOracleHashArtifacts = computeOracleArtifacts();
delete selfDeclaredOracleHashArtifacts.oracle_implementation_artifact;
const selfDeclaredOracleHashArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: selfDeclaredOracleHashArtifacts,
    },
  },
);
function runtimeArtifactWithOracleImplementationBinding(bindingOverrides) {
  const artifacts = computeOracleArtifacts();
  artifacts.oracle_implementation_artifact = {
    ...artifacts.oracle_implementation_artifact,
    ...bindingOverrides,
  };
  return runtimeArtifactForContract(acceptanceContract(), {
    oracle_artifacts: {
      compute_oracle_artifacts: artifacts,
    },
  });
}
const wrongOracleImplementationRoleArtifact = runtimeArtifactWithOracleImplementationBinding({
  role: 'raw_readback',
});
const wrongOracleImplementationLengthArtifact = runtimeArtifactWithOracleImplementationBinding({
  byte_length: ORACLE_IMPLEMENTATION_BYTES.length + 1,
});
const forgedOracleImplementationBytesArtifact = runtimeArtifactWithOracleImplementationBinding({
  path: FORGED_ORACLE_IMPLEMENTATION_CAS.storage.localPath,
  byte_length: FORGED_ORACLE_IMPLEMENTATION_CAS.byteLength,
});
const oracleCasArtifacts = computeOracleArtifacts();
delete oracleCasArtifacts.oracle_implementation_artifact;
oracleCasArtifacts.artifact_cas_locators = [ORACLE_IMPLEMENTATION_CAS];
const oracleCasArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: oracleCasArtifacts,
    },
  },
);
const malformedPeerArtifacts = computeOracleArtifacts({
  artifact_cas_locators: [ORACLE_IMPLEMENTATION_CAS, {}],
});
const malformedPeerArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: malformedPeerArtifacts,
    },
  },
);
const invalidPeerArtifacts = computeOracleArtifacts({
  artifact_cas_locators: [ORACLE_IMPLEMENTATION_CAS, locatorWithoutManifestHash(
    ORACLE_IMPLEMENTATION_CAS,
    {
    schemaVersion: 'synthi.cas.artifact_locator.v0',
    },
  )],
});
const invalidPeerArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: invalidPeerArtifacts,
    },
  },
);
const authorityClaimPeerArtifacts = computeOracleArtifacts({
  artifact_cas_locators: [
    ORACLE_IMPLEMENTATION_CAS,
    { ...ORACLE_IMPLEMENTATION_CAS, acceptedForGpuHmr: true },
  ],
});
const authorityClaimPeerArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: authorityClaimPeerArtifacts,
    },
  },
);
const conflictingPeerArtifacts = computeOracleArtifacts({
  artifact_cas_locators: [ORACLE_IMPLEMENTATION_CAS, FORGED_ORACLE_IMPLEMENTATION_CAS],
});
const conflictingPeerArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: conflictingPeerArtifacts,
    },
  },
);
const forgedPeerArtifacts = computeOracleArtifacts({
  oracle_implementation_locator: {
    ...locatorWithoutManifestHash(FORGED_ORACLE_IMPLEMENTATION_CAS),
    contentHash: HASH_C,
    artifactId: `artifact:${HASH_C}`,
  },
});
const forgedPeerArtifact = runtimeArtifactForContract(
  acceptanceContract(),
  {
    oracle_artifacts: {
      compute_oracle_artifacts: forgedPeerArtifacts,
    },
  },
);
function explicitRootComputeArtifacts(oracleImplementationPath) {
  const artifacts = computeOracleArtifacts({
    raw_readback_bin: EXPLICIT_COMPUTE_RAW_PATH,
    readback_schema_json: EXPLICIT_COMPUTE_SCHEMA_PATH,
  });
  artifacts.oracle_implementation_artifact = {
    ...artifacts.oracle_implementation_artifact,
    path: oracleImplementationPath,
  };
  return artifacts;
}

const inRootDirectArtifacts = explicitRootComputeArtifacts(
  EXPLICIT_ORACLE_IMPLEMENTATION_PATH,
);
const inRootDirectArtifact = runtimeArtifactForContract(acceptanceContract(), {
  oracle_artifacts: { compute_oracle_artifacts: inRootDirectArtifacts },
});
const outsideRootDirectArtifacts = explicitRootComputeArtifacts(
  ORACLE_IMPLEMENTATION_PATH,
);
const outsideRootDirectArtifact = runtimeArtifactForContract(acceptanceContract(), {
  oracle_artifacts: { compute_oracle_artifacts: outsideRootDirectArtifacts },
});
const inRootCasArtifacts = explicitRootComputeArtifacts(
  EXPLICIT_ORACLE_IMPLEMENTATION_PATH,
);
delete inRootCasArtifacts.oracle_implementation_artifact;
inRootCasArtifacts.artifact_cas_locators = [EXPLICIT_ORACLE_IMPLEMENTATION_CAS];
const inRootCasArtifact = runtimeArtifactForContract(acceptanceContract(), {
  oracle_artifacts: { compute_oracle_artifacts: inRootCasArtifacts },
});
const outsideRootCasArtifacts = explicitRootComputeArtifacts(
  EXPLICIT_ORACLE_IMPLEMENTATION_PATH,
);
delete outsideRootCasArtifacts.oracle_implementation_artifact;
outsideRootCasArtifacts.artifact_cas_locators = [ORACLE_IMPLEMENTATION_CAS];
outsideRootCasArtifacts.allowed_cas_roots = [SELF_CHECK_CAS_ROOT];
const outsideRootCasArtifact = runtimeArtifactForContract(acceptanceContract(), {
  oracle_artifacts: { compute_oracle_artifacts: outsideRootCasArtifacts },
});
const backendMatchedComputeOnlyLedger = buildGpuHmrProofLedger(ledgerRecord({
  contract_hash: passingArtifact.acceptanceContract.contract_hash,
  output_event: {
    id: 'output-compute-only-1',
    kind: 'compute_readback',
    epoch: 'epoch-7',
    artifact_hash: HASH_B,
    process_id: 'pid-1',
    after_dispatch_id: 'dispatch-1',
    output_target_id: 'allocation-1',
    oracle_code_hash: HASH_C,
    passed: true,
    timestamp_monotonic_ns: 400,
  },
  output_oracle_target: {
    kind: 'compute',
    target_id: 'allocation-1',
    compute_only_target_verified: true,
    evidence_refs: ['runtime:compute-readback'],
  },
}));
const backendMismatchLedger = buildGpuHmrProofLedger(ledgerRecord({
  contract_hash: passingArtifact.acceptanceContract.contract_hash,
  backend: 'webgpu',
  device_identity: {
    ...ledgerRecord().device_identity,
    backend: 'webgpu',
  },
}));
const backendMismatchArtifact = runtimeArtifact({
  proofLedger: backendMismatchLedger,
  proofLedgerQuery: backendMismatchLedger.query,
});
const visualContract = visualAcceptanceContract();
const visualContractEvaluation = evaluateGpuHmrAcceptanceContract(visualContract);
const visualContractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
  explicitContract: visualContract,
  derivedContract: visualContract,
  derivedEvaluation: visualContractEvaluation,
});
const byteBackedVisualLedger = buildGpuHmrProofLedger(boundVisualLedgerRecord({
  contract_hash: visualContract.contract_hash,
  oracle_artifacts: {
    visual_oracle_artifacts: byteBackedVisualOracleArtifacts(),
  },
}));
const byteBackedVisualArtifact = runtimeArtifact({
  proofId: 'strict-visual-runtime-proof-artifact:byte-backed-pass',
  proofLedger: byteBackedVisualLedger,
  proofLedgerQuery: byteBackedVisualLedger.query,
  acceptanceContract: visualContract,
  acceptanceContractEvaluation: visualContractEvaluation,
  acceptanceContractConsistency: visualContractConsistency,
  deterministicVisualModeEvaluation: { accepted: true },
});
const casOnlyVisualLedger = buildGpuHmrProofLedger(boundVisualLedgerRecord({
  contract_hash: visualContract.contract_hash,
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
  acceptanceContract: visualContract,
  acceptanceContractEvaluation: visualContractEvaluation,
  acceptanceContractConsistency: visualContractConsistency,
  deterministicVisualModeEvaluation: { accepted: true },
});
const computeContractForVisualOnly = acceptanceContract();
const visualOnlyForComputeLedger = buildGpuHmrProofLedger(boundVisualLedgerRecord({
  contract_hash: computeContractForVisualOnly.contract_hash,
  oracle_artifacts: {
    visual_oracle_artifacts: byteBackedVisualOracleArtifacts(),
  },
}));
const visualOnlyForComputeContractArtifact = runtimeArtifactForLedgerAndContract(
  computeContractForVisualOnly,
  visualOnlyForComputeLedger,
  { deterministicVisualModeEvaluation: { accepted: true } },
);
const computeOnlyForVisualContractArtifact = runtimeArtifactForContract(visualContract);

const materializedOracleCasArtifacts = await computeOracleArtifactsFromFiles(oracleCasArtifacts, {
  allowedRoots: [SELF_CHECK_CAS_ROOT],
  artifactRoot: SELF_CHECK_CAS_ROOT,
});
assert.equal(materializedOracleCasArtifacts.compute_artifact_cas_resolution.accepted, true);
assert.equal(
  materializedOracleCasArtifacts.semantic_oracle_implementation,
  ORACLE_IMPLEMENTATION_CAS.storage.localPath,
);
const previousGpuHmrCasRoot = process.env.SYNTHI_GPU_HMR_CAS_ROOT;
process.env.SYNTHI_GPU_HMR_CAS_ROOT = SELF_CHECK_CAS_ROOT;
try {
  const ambientRootMaterialization = await computeOracleArtifactsFromFiles(oracleCasArtifacts);
  assert.equal(ambientRootMaterialization.compute_artifact_cas_resolution.accepted, true);
  assert.equal(
    ambientRootMaterialization.semantic_oracle_implementation,
    ORACLE_IMPLEMENTATION_CAS.storage.localPath,
  );

  const arrayRootAliases = [
    'allowedRoots',
    'allowed_roots',
    'allowedArtifactRoots',
    'allowed_artifact_roots',
    'allowedCasRoots',
    'allowed_cas_roots',
    'computeArtifactRoots',
    'compute_artifact_roots',
  ];
  for (const alias of arrayRootAliases) {
    for (const explicitRoots of [[], [EXPLICIT_COMPUTE_ROOT]]) {
      const materialized = await computeOracleArtifactsFromFiles(
        oracleCasArtifacts,
        { [alias]: explicitRoots },
      );
      assert.equal(
        materialized.compute_artifact_cas_resolution.accepted,
        false,
        `${alias} must be exclusive even when SYNTHI_GPU_HMR_CAS_ROOT is set`,
      );
      assert.equal(materialized.semantic_oracle_implementation, undefined);
    }
  }

  const singularRootAliases = [
    'artifactRoot',
    'artifact_root',
    'artifactCasRoot',
    'artifact_cas_root',
    'casRoot',
    'cas_root',
  ];
  for (const alias of singularRootAliases) {
    const materialized = await computeOracleArtifactsFromFiles(
      oracleCasArtifacts,
      { [alias]: EXPLICIT_COMPUTE_ROOT },
    );
    assert.equal(
      materialized.compute_artifact_cas_resolution.accepted,
      false,
      `${alias} must not merge the ambient CAS root`,
    );
    assert.equal(materialized.semantic_oracle_implementation, undefined);
  }
} finally {
  if (previousGpuHmrCasRoot === undefined) {
    delete process.env.SYNTHI_GPU_HMR_CAS_ROOT;
  } else {
    process.env.SYNTHI_GPU_HMR_CAS_ROOT = previousGpuHmrCasRoot;
  }
}
const materializedDirectComputeArtifacts = await computeOracleArtifactsFromFiles(
  computeOracleArtifacts(),
  {
    expectedOutputContract: COMPUTE_EXPECTED_OUTPUT_CONTRACT,
    observedBinding: {
      projectId: 'strict-generic-gpu-project',
      editId: 'gpu-artifact-edit',
      artifactAfterHash: HASH_B,
      outputTargetId: 'allocation-1',
      oracleCodeHash: HASH_C,
    },
  },
);
assert.equal(
  materializedDirectComputeArtifacts.compute_oracle_semantic_verification.accepted,
  true,
  JSON.stringify(materializedDirectComputeArtifacts.compute_oracle_semantic_verification),
);
assert.equal(materializedDirectComputeArtifacts.raw_readback_hash_verified, true);
const validationMalformedPeer = await computeOracleArtifactsFromFiles(malformedPeerArtifacts, {
  allowedRoots: [SELF_CHECK_CAS_ROOT],
  artifactRoot: SELF_CHECK_CAS_ROOT,
});
assert.equal(validationMalformedPeer.compute_artifact_cas_resolution.accepted, false);
assert.equal(validationMalformedPeer.semantic_oracle_implementation, undefined);
const validationAuthorityClaimPeer = await computeOracleArtifactsFromFiles(
  authorityClaimPeerArtifacts,
  {
    allowedRoots: [SELF_CHECK_CAS_ROOT],
    artifactRoot: SELF_CHECK_CAS_ROOT,
  },
);
assert.equal(validationAuthorityClaimPeer.compute_artifact_cas_resolution.accepted, false);
assert.equal(validationAuthorityClaimPeer.semantic_oracle_implementation, undefined);

function hostileLiveProxy() {
  return new Proxy({}, {
    get() {
      throw new Error('proxy_get_trap_must_not_run');
    },
    getOwnPropertyDescriptor() {
      throw new Error('proxy_descriptor_trap_must_not_run');
    },
    getPrototypeOf() {
      throw new Error('proxy_prototype_trap_must_not_run');
    },
    ownKeys() {
      throw new Error('proxy_own_keys_trap_must_not_run');
    },
  });
}

function revokedProxy() {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

function accessorObject(onRead) {
  const value = {};
  Object.defineProperty(value, 'forbidden', {
    enumerable: true,
    get() {
      onRead();
      throw new Error('accessor_must_not_run');
    },
  });
  return value;
}

function assertStrictBoundaryFailure(input, expectedCode) {
  let result;
  assert.doesNotThrow(() => {
    result = runtimeProofArtifactStrictGate(input);
  });
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.includes(expectedCode), JSON.stringify(result));
}

async function assertComputeArtifactBoundaryFailure(input, expectedCode) {
  let result;
  await assert.doesNotReject(async () => {
    result = await computeOracleArtifactsFromFiles(input);
  });
  assert.equal(result.accepted, false);
  assert.ok(result.failedGates.includes(expectedCode), JSON.stringify(result));
}

function assertStrictOptionsBoundaryFailure(options, expectedCode) {
  let result;
  assert.doesNotThrow(() => {
    result = runtimeProofArtifactStrictGate(passingArtifact, options);
  });
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.includes(expectedCode), JSON.stringify(result));
}

async function assertComputeArtifactOptionsBoundaryFailure(options, expectedCode) {
  let result;
  await assert.doesNotReject(async () => {
    result = await computeOracleArtifactsFromFiles({}, options);
  });
  assert.equal(result.accepted, false);
  assert.ok(result.failedGates.includes(expectedCode), JSON.stringify(result));
}

function hostilePlainDataCases(onAccessorRead) {
  const cyclic = {};
  cyclic.self = cyclic;
  const nestedCyclic = { nested: {} };
  nestedCyclic.nested.parent = nestedCyclic;
  const symbolProperty = {};
  symbolProperty[Symbol('forbidden')] = true;
  const invalidPrototype = Object.create({ inherited: true });
  invalidPrototype.value = true;
  return [
    ['root-live-proxy', hostileLiveProxy(), 'proxy'],
    ['nested-live-proxy', { nested: hostileLiveProxy() }, 'proxy'],
    ['root-revoked-proxy', revokedProxy(), 'proxy'],
    ['nested-revoked-proxy', { nested: revokedProxy() }, 'proxy'],
    ['root-accessor', accessorObject(onAccessorRead), 'accessor_property'],
    ['nested-accessor', { nested: accessorObject(onAccessorRead) }, 'accessor_property'],
    ['root-cycle', cyclic, 'cycle'],
    ['nested-cycle', nestedCyclic, 'cycle'],
    ['function', () => {}, 'function_value'],
    ['bigint', 1n, 'bigint'],
    ['nested-undefined', { nested: undefined }, 'undefined_value'],
    ['nested-symbol', { nested: Symbol('forbidden') }, 'symbol_value'],
    ['symbol-property', symbolProperty, 'symbol_property'],
    ['nonfinite-number', { nested: Number.NaN }, 'nonfinite_number'],
    ['negative-zero', { nested: -0 }, 'negative_zero'],
    ['sparse-array', { nested: [1, , 3] }, 'array_shape'],
    ['invalid-prototype', { nested: invalidPrototype }, 'object_prototype'],
  ];
}

function validationRefusalCodes(result) {
  const rows = Array.isArray(result) ? result : [result];
  const codes = [];
  for (const row of rows) {
    for (const record of [row, row?.artifact]) {
      if (!record || typeof record !== 'object') continue;
      for (const key of ['failedGates', 'failed_gates', 'reasons', 'limitations']) {
        const values = Array.isArray(record[key]) ? record[key] : [];
        for (const value of values) {
          if (typeof value === 'string') codes.push(value);
          else if (value && typeof value.code === 'string') codes.push(value.code);
        }
      }
    }
  }
  return codes;
}

function assertValidationRefusal(result, expectedCode, label) {
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row?.accepted, false, `${label}: expected a refusal result`);
  assert.ok(
    validationRefusalCodes(result).includes(expectedCode),
    `${label}: ${JSON.stringify(result)}`,
  );
}

function assertSyncValidationBoundaryMatrix(label, invoke, expectedCode) {
  let accessorReads = 0;
  for (const [caseName, input, suffix] of hostilePlainDataCases(() => {
    accessorReads += 1;
  })) {
    let result;
    assert.doesNotThrow(() => {
      result = invoke(input);
    }, `${label}:${caseName}`);
    assertValidationRefusal(result, expectedCode(suffix), `${label}:${caseName}`);
  }
  assert.equal(accessorReads, 0, `${label}: accessors must not execute`);
}

async function assertAsyncValidationBoundaryMatrix(label, invoke, expectedCode) {
  let accessorReads = 0;
  for (const [caseName, input, suffix] of hostilePlainDataCases(() => {
    accessorReads += 1;
  })) {
    let result;
    await assert.doesNotReject(async () => {
      result = await invoke(input);
    }, `${label}:${caseName}`);
    assertValidationRefusal(result, expectedCode(suffix), `${label}:${caseName}`);
  }
  assert.equal(accessorReads, 0, `${label}: accessors must not execute`);
}

function assertSyncValidationRefusal(label, invoke, expectedCode) {
  let result;
  assert.doesNotThrow(() => {
    result = invoke();
  }, label);
  assertValidationRefusal(result, expectedCode, label);
}

async function assertAsyncValidationRefusal(label, invoke, expectedCode) {
  let result;
  await assert.doesNotReject(async () => {
    result = await invoke();
  }, label);
  assertValidationRefusal(result, expectedCode, label);
}

assertSyncValidationBoundaryMatrix(
  'visualEvidenceArtifactsFromVisualOracleArtifacts input',
  (input) => visualEvidenceArtifactsFromVisualOracleArtifacts(input),
  (suffix) => `visual_oracle_evidence_plain_data_${suffix}`,
);
assertSyncValidationBoundaryMatrix(
  'visualEvidenceArtifactsFromVisualOracleArtifacts options',
  (input) => visualEvidenceArtifactsFromVisualOracleArtifacts({}, input),
  (suffix) => `visual_oracle_evidence_options_plain_data_${suffix}`,
);
assertSyncValidationBoundaryMatrix(
  'buildValidationRuntimeProofArtifact input',
  (input) => buildValidationRuntimeProofArtifact(input),
  (suffix) => `validation_runtime_proof_plain_data_${suffix}`,
);
await assertAsyncValidationBoundaryMatrix(
  'visualEvidenceArtifactsFromFiles paths',
  (input) => visualEvidenceArtifactsFromFiles(input, []),
  (suffix) => `visual_evidence_paths_plain_data_${suffix}`,
);
await assertAsyncValidationBoundaryMatrix(
  'visualEvidenceArtifactsFromFiles existing artifacts',
  (input) => visualEvidenceArtifactsFromFiles([], input),
  (suffix) => `visual_evidence_existing_artifacts_plain_data_${suffix}`,
);
await assertAsyncValidationBoundaryMatrix(
  'verifyComputeOracleArtifactBundle input',
  (input) => verifyComputeOracleArtifactBundle(input),
  (suffix) => `compute_oracle_artifact_bundle_plain_data_${suffix}`,
);
await assertAsyncValidationBoundaryMatrix(
  'verifyComputeOracleArtifactBundle options',
  (input) => verifyComputeOracleArtifactBundle({}, input),
  (suffix) => `compute_oracle_artifact_bundle_options_plain_data_${suffix}`,
);
await assertAsyncValidationBoundaryMatrix(
  'computeOracleArtifactsFromFiles input',
  (input) => computeOracleArtifactsFromFiles(input),
  (suffix) => `compute_oracle_artifacts_plain_data_${suffix}`,
);
await assertAsyncValidationBoundaryMatrix(
  'computeOracleArtifactsFromFiles options',
  (input) => computeOracleArtifactsFromFiles({}, input),
  (suffix) => `compute_oracle_artifacts_options_plain_data_${suffix}`,
);
await assertAsyncValidationBoundaryMatrix(
  'visualOracleArtifactsFromFiles input',
  (input) => visualOracleArtifactsFromFiles(input),
  (suffix) => `visual_oracle_artifacts_plain_data_${suffix}`,
);
await assertAsyncValidationBoundaryMatrix(
  'writeValidationRuntimeProofArtifact output path',
  (input) => writeValidationRuntimeProofArtifact(input, {}),
  (suffix) => `validation_runtime_proof_output_path_plain_data_${suffix}`,
);
await assertAsyncValidationBoundaryMatrix(
  'writeValidationRuntimeProofArtifact input',
  (input) => writeValidationRuntimeProofArtifact(SELF_CHECK_ARTIFACT_DIR, input),
  (suffix) => `validation_runtime_proof_write_input_plain_data_${suffix}`,
);

assertSyncValidationRefusal(
  'visual oracle evidence undefined input',
  () => visualEvidenceArtifactsFromVisualOracleArtifacts(undefined),
  'visual_oracle_evidence_plain_data_undefined_value',
);
assertSyncValidationRefusal(
  'visual oracle evidence undefined options',
  () => visualEvidenceArtifactsFromVisualOracleArtifacts({}, undefined),
  'visual_oracle_evidence_options_plain_data_undefined_value',
);
assertSyncValidationRefusal(
  'validation runtime proof undefined input',
  () => buildValidationRuntimeProofArtifact(undefined),
  'validation_runtime_proof_plain_data_undefined_value',
);
await assertAsyncValidationRefusal(
  'visual evidence undefined paths',
  () => visualEvidenceArtifactsFromFiles(undefined),
  'visual_evidence_paths_plain_data_undefined_value',
);
await assertAsyncValidationRefusal(
  'visual evidence undefined existing artifacts',
  () => visualEvidenceArtifactsFromFiles([], undefined),
  'visual_evidence_existing_artifacts_plain_data_undefined_value',
);
await assertAsyncValidationRefusal(
  'compute bundle undefined input',
  () => verifyComputeOracleArtifactBundle(undefined),
  'compute_oracle_artifact_bundle_plain_data_undefined_value',
);
await assertAsyncValidationRefusal(
  'compute bundle undefined options',
  () => verifyComputeOracleArtifactBundle({}, undefined),
  'compute_oracle_artifact_bundle_options_plain_data_undefined_value',
);
await assertAsyncValidationRefusal(
  'compute artifacts undefined input',
  () => computeOracleArtifactsFromFiles(undefined),
  'compute_oracle_artifacts_plain_data_undefined_value',
);
await assertAsyncValidationRefusal(
  'compute artifacts undefined options',
  () => computeOracleArtifactsFromFiles({}, undefined),
  'compute_oracle_artifacts_options_plain_data_undefined_value',
);
await assertAsyncValidationRefusal(
  'visual oracle undefined input',
  () => visualOracleArtifactsFromFiles(undefined),
  'visual_oracle_artifacts_plain_data_undefined_value',
);
await assertAsyncValidationRefusal(
  'validation proof undefined output path',
  () => writeValidationRuntimeProofArtifact(undefined, {}),
  'validation_runtime_proof_output_path_plain_data_undefined_value',
);
await assertAsyncValidationRefusal(
  'validation proof undefined input',
  () => writeValidationRuntimeProofArtifact(SELF_CHECK_ARTIFACT_DIR, undefined),
  'validation_runtime_proof_write_input_plain_data_undefined_value',
);

assertSyncValidationRefusal(
  'visual oracle evidence primitive input',
  () => visualEvidenceArtifactsFromVisualOracleArtifacts(42),
  'visual_oracle_evidence_input_not_object',
);
assertSyncValidationRefusal(
  'visual oracle evidence primitive options',
  () => visualEvidenceArtifactsFromVisualOracleArtifacts({}, 42),
  'visual_oracle_evidence_options_not_object',
);
assertSyncValidationRefusal(
  'validation runtime proof primitive input',
  () => buildValidationRuntimeProofArtifact(42),
  'validation_runtime_proof_input_not_object',
);
await assertAsyncValidationRefusal(
  'visual evidence primitive paths',
  () => visualEvidenceArtifactsFromFiles('unsafe-path', []),
  'visual_evidence_paths_not_array',
);
await assertAsyncValidationRefusal(
  'visual evidence primitive existing artifacts',
  () => visualEvidenceArtifactsFromFiles([], 42),
  'visual_evidence_existing_artifacts_not_array',
);
await assertAsyncValidationRefusal(
  'compute bundle primitive input',
  () => verifyComputeOracleArtifactBundle(42),
  'compute_oracle_artifact_bundle_input_not_object',
);
await assertAsyncValidationRefusal(
  'compute bundle primitive options',
  () => verifyComputeOracleArtifactBundle({}, 42),
  'compute_oracle_artifact_bundle_options_not_object',
);
await assertAsyncValidationRefusal(
  'compute artifacts primitive input',
  () => computeOracleArtifactsFromFiles(42),
  'compute_oracle_artifacts_input_not_object',
);
await assertAsyncValidationRefusal(
  'compute artifacts primitive options',
  () => computeOracleArtifactsFromFiles({}, 42),
  'compute_oracle_artifacts_options_not_object',
);
await assertAsyncValidationRefusal(
  'visual oracle primitive input',
  () => visualOracleArtifactsFromFiles(42),
  'visual_oracle_artifacts_input_not_object',
);
await assertAsyncValidationRefusal(
  'validation proof primitive output path',
  () => writeValidationRuntimeProofArtifact(42, {}),
  'validation_runtime_proof_output_path_invalid',
);
await assertAsyncValidationRefusal(
  'validation proof primitive input',
  () => writeValidationRuntimeProofArtifact(SELF_CHECK_ARTIFACT_DIR, 42),
  'validation_runtime_proof_write_input_not_object',
);
for (const unsafeOutputPath of ['', '   ', `unsafe\0path`]) {
  await assertAsyncValidationRefusal(
    'validation proof unsafe output path',
    () => writeValidationRuntimeProofArtifact(unsafeOutputPath, {}),
    'validation_runtime_proof_output_path_invalid',
  );
}
await assertAsyncValidationRefusal(
  'validation proof filesystem-root output path',
  () => writeValidationRuntimeProofArtifact(
    path.parse(path.resolve(SELF_CHECK_ARTIFACT_DIR)).root,
    {},
  ),
  'validation_runtime_proof_output_path_filesystem_root_forbidden',
);

const strictRootLiveProxy = hostileLiveProxy();
const strictNestedLiveProxy = { nested: hostileLiveProxy() };
const strictRootRevokedProxy = revokedProxy();
const strictNestedRevokedProxy = { nested: revokedProxy() };
let strictAccessorReadCount = 0;
const strictRootAccessor = accessorObject(() => { strictAccessorReadCount += 1; });
const strictNestedAccessor = {
  nested: accessorObject(() => { strictAccessorReadCount += 1; }),
};
assertStrictBoundaryFailure(
  strictRootLiveProxy,
  'runtime_proof_artifact_plain_data_proxy',
);
assertStrictBoundaryFailure(
  strictNestedLiveProxy,
  'runtime_proof_artifact_plain_data_proxy',
);
assertStrictBoundaryFailure(
  strictRootRevokedProxy,
  'runtime_proof_artifact_plain_data_proxy',
);
assertStrictBoundaryFailure(
  strictNestedRevokedProxy,
  'runtime_proof_artifact_plain_data_proxy',
);
assertStrictBoundaryFailure(
  strictRootAccessor,
  'runtime_proof_artifact_plain_data_accessor_property',
);
assertStrictBoundaryFailure(
  strictNestedAccessor,
  'runtime_proof_artifact_plain_data_accessor_property',
);
assert.equal(strictAccessorReadCount, 0);

const computeRootLiveProxy = hostileLiveProxy();
const computeNestedLiveProxy = { nested: hostileLiveProxy() };
const computeRootRevokedProxy = revokedProxy();
const computeNestedRevokedProxy = { nested: revokedProxy() };
let computeAccessorReadCount = 0;
const computeRootAccessor = accessorObject(() => { computeAccessorReadCount += 1; });
const computeNestedAccessor = {
  nested: accessorObject(() => { computeAccessorReadCount += 1; }),
};
await assertComputeArtifactBoundaryFailure(
  computeRootLiveProxy,
  'compute_oracle_artifacts_plain_data_proxy',
);
await assertComputeArtifactBoundaryFailure(
  computeNestedLiveProxy,
  'compute_oracle_artifacts_plain_data_proxy',
);
await assertComputeArtifactBoundaryFailure(
  computeRootRevokedProxy,
  'compute_oracle_artifacts_plain_data_proxy',
);
await assertComputeArtifactBoundaryFailure(
  computeNestedRevokedProxy,
  'compute_oracle_artifacts_plain_data_proxy',
);
await assertComputeArtifactBoundaryFailure(
  computeRootAccessor,
  'compute_oracle_artifacts_plain_data_accessor_property',
);
await assertComputeArtifactBoundaryFailure(
  computeNestedAccessor,
  'compute_oracle_artifacts_plain_data_accessor_property',
);
assert.equal(computeAccessorReadCount, 0);

let optionsAccessorReadCount = 0;
const strictOptionsAccessor = accessorObject(() => { optionsAccessorReadCount += 1; });
const computeOptionsAccessor = accessorObject(() => { optionsAccessorReadCount += 1; });
assertStrictOptionsBoundaryFailure(
  hostileLiveProxy(),
  'runtime_proof_artifact_options_plain_data_proxy',
);
assertStrictOptionsBoundaryFailure(
  revokedProxy(),
  'runtime_proof_artifact_options_plain_data_proxy',
);
assertStrictOptionsBoundaryFailure(
  strictOptionsAccessor,
  'runtime_proof_artifact_options_plain_data_accessor_property',
);
await assertComputeArtifactOptionsBoundaryFailure(
  hostileLiveProxy(),
  'compute_oracle_artifacts_options_plain_data_proxy',
);
await assertComputeArtifactOptionsBoundaryFailure(
  revokedProxy(),
  'compute_oracle_artifacts_options_plain_data_proxy',
);
await assertComputeArtifactOptionsBoundaryFailure(
  computeOptionsAccessor,
  'compute_oracle_artifacts_options_plain_data_accessor_property',
);
assert.equal(optionsAccessorReadCount, 0);

function assertAdversarialPreflightBoundaryFailure(input, expectedCode, options = {}) {
  let result;
  assert.doesNotThrow(() => {
    result = adversarialPreflightStrictGate(input, options);
  });
  assert.equal(result.status, 'fail');
  assert.ok(result.failures.includes(expectedCode), JSON.stringify(result));
}

function assertRuntimeProofArtifactsBoundaryFailure(input, expectedCode, options = {}) {
  let result;
  assert.doesNotThrow(() => {
    result = runtimeProofArtifactStrictGates(input, options);
  });
  assert.equal(Array.isArray(result), true);
  assert.equal(result[0]?.status, 'fail');
  assert.ok(result[0]?.failures.includes(expectedCode), JSON.stringify(result));
}

function assertStrictProofFailuresBoundaryFailure(input, expectedCode) {
  let result;
  assert.doesNotThrow(() => {
    result = strictProofGateFailures(input);
  });
  assert.equal(Array.isArray(result), true);
  assert.equal(result[0]?.status, 'fail');
  assert.ok(result[0]?.failures.includes(expectedCode), JSON.stringify(result));
}

for (const proxyFactory of [hostileLiveProxy, revokedProxy]) {
  assertAdversarialPreflightBoundaryFailure(
    proxyFactory(),
    'adversarial_preflight_plain_data_proxy',
  );
  assertAdversarialPreflightBoundaryFailure(
    { nested: proxyFactory() },
    'adversarial_preflight_plain_data_proxy',
  );
  assertRuntimeProofArtifactsBoundaryFailure(
    proxyFactory(),
    'runtime_proof_artifacts_plain_data_proxy',
  );
  assertRuntimeProofArtifactsBoundaryFailure(
    [proxyFactory()],
    'runtime_proof_artifacts_plain_data_proxy',
  );
  assertStrictProofFailuresBoundaryFailure(
    proxyFactory(),
    'strict_proof_gate_rows_plain_data_proxy',
  );
  assertStrictProofFailuresBoundaryFailure(
    [proxyFactory()],
    'strict_proof_gate_rows_plain_data_proxy',
  );
  assertAdversarialPreflightBoundaryFailure(
    passingPreflight,
    'adversarial_preflight_options_plain_data_proxy',
    proxyFactory(),
  );
  assertRuntimeProofArtifactsBoundaryFailure(
    [passingArtifact],
    'runtime_proof_artifacts_options_plain_data_proxy',
    proxyFactory(),
  );
}

for (const [input, suffix] of [
  [undefined, 'undefined_value'],
  [() => {}, 'function_value'],
]) {
  assertAdversarialPreflightBoundaryFailure(
    input,
    `adversarial_preflight_plain_data_${suffix}`,
  );
  assertRuntimeProofArtifactsBoundaryFailure(
    input,
    `runtime_proof_artifacts_plain_data_${suffix}`,
  );
  assertStrictProofFailuresBoundaryFailure(
    input,
    `strict_proof_gate_rows_plain_data_${suffix}`,
  );
}

const symbolProperty = { nested: {} };
symbolProperty.nested[Symbol('forbidden')] = true;
const cyclicValue = {};
cyclicValue.self = cyclicValue;
const nonPlainPrototypeValue = Object.create({ inherited: true });
nonPlainPrototypeValue.value = true;
const invalidPlainDataCases = [
  [{ nested: undefined }, 'undefined_value'],
  [{ nested() {} }, 'function_value'],
  [{ nested: Symbol('forbidden') }, 'symbol_value'],
  [symbolProperty, 'symbol_property'],
  [{ nested: 1n }, 'bigint'],
  [{ nested: Number.NaN }, 'nonfinite_number'],
  [{ nested: Number.POSITIVE_INFINITY }, 'nonfinite_number'],
  [{ nested: -0 }, 'negative_zero'],
  [{ nested: [1, , 3] }, 'array_shape'],
  [cyclicValue, 'cycle'],
  [{ nested: nonPlainPrototypeValue }, 'object_prototype'],
];
for (const [input, suffix] of invalidPlainDataCases) {
  assertStrictBoundaryFailure(input, `runtime_proof_artifact_plain_data_${suffix}`);
  await assertComputeArtifactBoundaryFailure(
    input,
    `compute_oracle_artifacts_plain_data_${suffix}`,
  );
}

assert.equal(adversarialPreflightStrictGate(passingPreflight).status, 'pass');
const passingStrictGate = runtimeProofArtifactStrictGate(passingArtifact);
assert.equal(passingStrictGate.status, 'pass', passingStrictGate.detail);
assert.equal(passingStrictGate.schemaVersion, 'synthi.gpu_hmr.strict_proof_gates.v2');
assert.equal(passingArtifact.acceptanceContractConsistency.checked, true);
const explicitComputeRootOptions = {
  allowedArtifactRoots: [EXPLICIT_COMPUTE_ROOT],
};
assert.equal(
  runtimeProofArtifactStrictGate(inRootDirectArtifact, explicitComputeRootOptions).status,
  'pass',
);
assert.equal(
  runtimeProofArtifactStrictGate(inRootCasArtifact, explicitComputeRootOptions).status,
  'pass',
);
const outsideRootDirectGate = runtimeProofArtifactStrictGate(
  outsideRootDirectArtifact,
  explicitComputeRootOptions,
);
assert.equal(outsideRootDirectGate.status, 'fail');
assert.match(
  outsideRootDirectGate.detail,
  /compute_oracle_implementation_artifact_path_unreadable|compute_oracle_implementation_bytes_unreadable/,
);
const outsideRootCasGate = runtimeProofArtifactStrictGate(
  outsideRootCasArtifact,
  explicitComputeRootOptions,
);
assert.equal(outsideRootCasGate.status, 'fail');
assert.match(
  outsideRootCasGate.detail,
  /compute_oracle_(artifact|oracle_implementation)_cas_locator_invalid|compute_oracle_implementation_bytes_unreadable/,
);
assert.equal(
  runtimeProofArtifactStrictGate(inRootDirectArtifact, { allowedArtifactRoots: [] }).status,
  'fail',
);
const strictComputeRootAliasSpecs = [
  ['computeArtifactRoots', true],
  ['compute_artifact_roots', true],
  ['allowedRoots', true],
  ['allowed_roots', true],
  ['allowedArtifactRoots', true],
  ['allowed_artifact_roots', true],
  ['allowedCasRoots', true],
  ['allowed_cas_roots', true],
  ['artifactRoot', false],
  ['artifact_root', false],
  ['artifactCasRoot', false],
  ['artifact_cas_root', false],
  ['casRoot', false],
  ['cas_root', false],
];
const strictRootPreviousGpuHmrCasRoot = process.env.SYNTHI_GPU_HMR_CAS_ROOT;
process.env.SYNTHI_GPU_HMR_CAS_ROOT = SELF_CHECK_CAS_ROOT;
try {
  for (const [alias, list] of strictComputeRootAliasSpecs) {
    const validOptions = {
      [alias]: list ? [EXPLICIT_COMPUTE_ROOT] : EXPLICIT_COMPUTE_ROOT,
    };
    assert.equal(
      runtimeProofArtifactStrictGate(inRootDirectArtifact, validOptions).status,
      'pass',
      `${alias} must authorize an in-root direct oracle implementation artifact`,
    );
    assert.equal(
      runtimeProofArtifactStrictGate(inRootCasArtifact, validOptions).status,
      'pass',
      `${alias} must authorize an in-root CAS oracle implementation artifact`,
    );

    for (const [caseName, declared] of list
      ? [
        ['empty', []],
        ['invalid-scalar', EXPLICIT_COMPUTE_ROOT],
        ['invalid-peer', [EXPLICIT_COMPUTE_ROOT, 42]],
      ]
      : [
        ['empty', ''],
        ['invalid-list', [EXPLICIT_COMPUTE_ROOT]],
        ['invalid-number', 42],
      ]) {
      const invalidOptions = { [alias]: declared };
      const directGate = runtimeProofArtifactStrictGate(inRootDirectArtifact, invalidOptions);
      const casGate = runtimeProofArtifactStrictGate(inRootCasArtifact, invalidOptions);
      assert.equal(
        directGate.status,
        'fail',
        `${alias}:${caseName} must disable default direct-artifact roots`,
      );
      assert.equal(
        casGate.status,
        'fail',
        `${alias}:${caseName} must disable ambient/default CAS roots`,
      );
    }

    const defaultRootDirectGate = runtimeProofArtifactStrictGate(passingArtifact, validOptions);
    const defaultRootCasGate = runtimeProofArtifactStrictGate(outsideRootCasArtifact, validOptions);
    assert.equal(
      defaultRootDirectGate.status,
      'fail',
      `${alias} must exclude a direct artifact available only through default roots`,
    );
    assert.equal(
      defaultRootCasGate.status,
      'fail',
      `${alias} must exclude a locator available only through the ambient/default CAS root`,
    );
  }
} finally {
  if (strictRootPreviousGpuHmrCasRoot === undefined) {
    delete process.env.SYNTHI_GPU_HMR_CAS_ROOT;
  } else {
    process.env.SYNTHI_GPU_HMR_CAS_ROOT = strictRootPreviousGpuHmrCasRoot;
  }
}
assertStrictSemanticRejection(
  unexpectedValuesArtifact,
  /compute_oracle_numeric_values_mismatch/,
);
assertStrictSemanticRejection(
  reboundTargetArtifact,
  /compute_oracle_binding_output_target_id_mismatch/,
);
assertStrictSemanticRejection(
  reboundOracleImplementationArtifact,
  /compute_oracle_binding_oracle_code_hash_mismatch/,
);
assertStrictSemanticRejection(
  conflictingExpectedOutputAliasArtifact,
  /compute_oracle_expected_output_contract_alias_conflict/,
);
const inheritedExpectedOutputAliasArtifact = structuredClone(passingArtifact);
delete inheritedExpectedOutputAliasArtifact
  .acceptanceContract.fission_report.output_oracle_contract.expected_output_contract;
const previousExpectedOutputDescriptor = Object.getOwnPropertyDescriptor(
  Object.prototype,
  'expected_output_contract',
);
Object.defineProperty(Object.prototype, 'expected_output_contract', {
  configurable: true,
  enumerable: false,
  writable: true,
  value: COMPUTE_EXPECTED_OUTPUT_CONTRACT,
});
try {
  assertStrictSemanticRejection(
    inheritedExpectedOutputAliasArtifact,
    /compute_oracle_expected_output_contract_prototype_inherited/,
  );
} finally {
  if (previousExpectedOutputDescriptor) {
    Object.defineProperty(
      Object.prototype,
      'expected_output_contract',
      previousExpectedOutputDescriptor,
    );
  } else {
    delete Object.prototype.expected_output_contract;
  }
}
assertStrictSemanticRejection(
  reboundSliceArtifact,
  /compute_oracle_deterministic_slice_schema_mismatch/,
);
assertStrictSemanticRejection(
  missingRuntimeTargetArtifact,
  /compute_oracle_semantic_output_target_id_output_event_missing|compute_oracle_semantic_output_target_id_runtime_observation_missing/,
);
assertStrictSemanticRejection(
  missingSchemaHashArtifact,
  /compute_oracle_semantic_readback_schema_hash_missing/,
);
assertStrictSemanticRejection(
  mixedVisualComputeArtifact,
  /compute_oracle_mixed_visual_compute_modality_ambiguous/,
);
assertStrictSemanticRejection(
  selfDeclaredOracleHashArtifact,
  /compute_oracle_implementation_byte_artifact_missing|compute_oracle_implementation_bytes_unreadable/,
);
assertStrictSemanticRejection(
  wrongOracleImplementationRoleArtifact,
  /compute_oracle_implementation_artifact_role_invalid/,
);
assertStrictSemanticRejection(
  wrongOracleImplementationLengthArtifact,
  /compute_oracle_implementation_artifact_byte_length_mismatch/,
);
assertStrictSemanticRejection(
  forgedOracleImplementationBytesArtifact,
  /compute_oracle_implementation_artifact_hash_mismatch|compute_oracle_implementation_oracle_code_hash_mismatch/,
);
assert.equal(
  runtimeProofArtifactStrictGate(oracleCasArtifact, {
    computeArtifactRoots: [SELF_CHECK_ARTIFACT_DIR, SELF_CHECK_CAS_ROOT],
  }).status,
  'pass',
);
assertStrictSemanticRejection(
  malformedPeerArtifact,
  /compute_oracle_(artifact|oracle_implementation)_cas_locator_invalid/,
);
assertStrictSemanticRejection(
  invalidPeerArtifact,
  /compute_oracle_(artifact|oracle_implementation)_cas_locator_invalid/,
);
assertStrictSemanticRejection(
  authorityClaimPeerArtifact,
  /compute_oracle_(artifact|oracle_implementation)_cas_locator_invalid/,
);
assertStrictSemanticRejection(
  conflictingPeerArtifact,
  /compute_oracle_(artifact|oracle_implementation)_cas_locator_invalid/,
);
assertStrictSemanticRejection(
  forgedPeerArtifact,
  /compute_oracle_(artifact|oracle_implementation)_cas_locator_invalid/,
);
assertStrictSemanticRejection(
  visualOnlyForComputeContractArtifact,
  /compute_oracle_required_ledger_(event|artifacts)_missing|acceptance_contract_ledger_oracle_modality_mismatch/,
);
assertStrictSemanticRejection(
  computeOnlyForVisualContractArtifact,
  /visual_oracle_required_ledger_(event|artifacts)_missing|acceptance_contract_ledger_oracle_modality_mismatch/,
);
assert.equal(runtimeProofArtifactStrictGate(runtimeArtifact({
  proofLedger: backendMatchedComputeOnlyLedger,
  proofLedgerQuery: backendMatchedComputeOnlyLedger.query,
})).status, 'pass');
assertStrictSemanticRejection(
  backendMismatchArtifact,
  /compute_oracle_semantic_backend_declaration_runtime_mismatch/,
);
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
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    acceptanceContractConsistency: { accepted: true, checked: false },
  }).detail,
  /acceptance_contract_consistency_unchecked/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    acceptanceContractConsistency: { accepted: true, checked: true },
    acceptance_contract_consistency: { accepted: true, checked: false },
  }).detail,
  /acceptance_contract_consistency_alias_mismatch/,
);
assert.match(
  runtimeProofArtifactStrictGate(runtimeArtifact((() => {
    const proofLedger = buildGpuHmrProofLedger(ledgerRecord({
      contract_hash: HASH_A,
    }));
    return {
      proofLedger,
      proofLedgerQuery: proofLedger.query,
    };
  })())).detail,
  /proof_ledger_acceptance_contract_hash_mismatch/,
);
const directRecordLedger = structuredClone(passingArtifact.proofLedger.records[0]);
const directRecordLedgerQuery = queryGpuHmrLedgerInvariants(directRecordLedger);
assert.equal(directRecordLedgerQuery.gpuHmrSuccess, true);
assert.equal(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofLedger: directRecordLedger,
    proofLedgerQuery: directRecordLedgerQuery,
  })).accepted,
  true,
);
const multiRecordOne = buildGpuHmrProofLedger(ledgerRecord({
  contract_hash: passingArtifact.acceptanceContract.contract_hash,
  evidence_refs: [
    'runtime:module-load',
    'runtime:epoch-publish',
    'runtime:dispatch',
    'runtime:output-oracle',
    'runtime:proof-observation:one',
  ],
})).records[0];
const multiRecordTwo = buildGpuHmrProofLedger(ledgerRecord({
  contract_hash: passingArtifact.acceptanceContract.contract_hash,
  evidence_refs: [
    'runtime:module-load',
    'runtime:epoch-publish',
    'runtime:dispatch',
    'runtime:output-oracle',
    'runtime:proof-observation:two',
  ],
})).records[0];
const passingMultiRecordLedger = proofLedgerFromRecords([multiRecordOne, multiRecordTwo]);
assert.equal(passingMultiRecordLedger.query.gpuHmrSuccess, true);
assert.equal(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofLedger: passingMultiRecordLedger,
    proofLedgerQuery: passingMultiRecordLedger.query,
  })).accepted,
  true,
);
const mismatchedSecondRecordLedger = proofLedgerFromRecords([
  multiRecordOne,
  buildGpuHmrProofLedger(ledgerRecord({
    contract_hash: HASH_A,
    evidence_refs: [
      'runtime:module-load',
      'runtime:epoch-publish',
      'runtime:dispatch',
      'runtime:output-oracle',
      'runtime:proof-observation:mismatched-contract',
    ],
  })).records[0],
]);
assert.equal(mismatchedSecondRecordLedger.query.gpuHmrSuccess, true);
assert.deepEqual(
  runtimeProofArtifactStrictGate(runtimeArtifact({
    proofLedger: mismatchedSecondRecordLedger,
    proofLedgerQuery: mismatchedSecondRecordLedger.query,
  })).failures,
  ['proof_ledger_acceptance_contract_hash_mismatch'],
);
assert.match(
  runtimeProofArtifactStrictGate((() => {
    const recordWithoutContractHash = structuredClone(multiRecordTwo);
    delete recordWithoutContractHash.contractHash;
    delete recordWithoutContractHash.contract_hash;
    const proofLedger = proofLedgerFromRecords([multiRecordOne, recordWithoutContractHash]);
    return runtimeArtifact({
      proofLedger,
      proofLedgerQuery: proofLedger.query,
    });
  })()).detail,
  /proof_ledger_acceptance_contract_hash_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate((() => {
    const recordWithConflictingAlias = structuredClone(multiRecordTwo);
    recordWithConflictingAlias.contract_hash = HASH_A;
    const proofLedger = proofLedgerFromRecords([multiRecordOne, recordWithConflictingAlias]);
    return runtimeArtifact({
      proofLedger,
      proofLedgerQuery: proofLedger.query,
    });
  })()).detail,
  /proof_ledger_acceptance_contract_hash_alias_mismatch/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    proof_ledger: buildGpuHmrProofLedger(ledgerRecord({ contract_hash: HASH_A })),
  }).detail,
  /proof_ledger_alias_mismatch/,
);
assert.match(
  runtimeProofArtifactStrictGate({
    ...passingArtifact,
    acceptance_contract: acceptanceContract({ project_id: 'alternate-generic-project' }),
  }).detail,
  /acceptance_contract_alias_mismatch/,
);
assert.match(
  runtimeProofArtifactStrictGate((() => {
    const record = structuredClone(passingArtifact.proofLedger.records[0]);
    delete record.contractHash;
    delete record.contract_hash;
    Object.setPrototypeOf(record, {
      contractHash: passingArtifact.acceptanceContract.contract_hash,
    });
    return runtimeArtifact({
      proofLedger: record,
      proofLedgerQuery: queryGpuHmrLedgerInvariants(record),
    });
  })()).detail,
  /runtime_proof_artifact_plain_data_object_prototype|proof_ledger_acceptance_contract_hash_missing/,
);
assert.match(
  runtimeProofArtifactStrictGate((() => {
    const maliciousLedger = buildGpuHmrProofLedger(ledgerRecord({ contract_hash: HASH_A }));
    const artifact = runtimeArtifact({
      proof_ledger: maliciousLedger,
      proof_ledger_query: maliciousLedger.query,
    });
    delete artifact.proofLedger;
    delete artifact.proofLedgerQuery;
    Object.setPrototypeOf(artifact, {
      proofLedger: passingArtifact.proofLedger,
      proofLedgerQuery: passingArtifact.proofLedgerQuery,
    });
    return artifact;
  })()).detail,
  /runtime_proof_artifact_plain_data_object_prototype|proof_ledger_acceptance_contract_hash_mismatch/,
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
        locatorWithoutManifestHash(VISUAL_BEFORE_CAS, {
          schemaVersion: 'synthi.cas.artifact_locator.v0',
          acceptedForGpuHmr: true,
        }),
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
        locatorWithoutManifestHash(VISUAL_BEFORE_CAS, {
          byteLength: VISUAL_BEFORE_CAS.byteLength + 1,
        }),
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
        locatorWithoutManifestHash(VISUAL_BEFORE_CAS, {
          artifactUri: `synthi-cas://strict_gates/sha256/${VISUAL_AFTER.hash.slice('sha256:'.length)}`,
        }),
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
        locatorWithoutManifestHash(VISUAL_BEFORE_CAS, {
          contentHash: VISUAL_AFTER.hash,
          artifactId: `artifact:${VISUAL_AFTER.hash}`,
        }),
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
