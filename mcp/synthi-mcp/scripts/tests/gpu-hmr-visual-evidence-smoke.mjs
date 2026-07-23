#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { writeArtifactToCas } from '../lib/gpu-hmr-artifact-cas.mjs';
import {
  buildAsyncVisualProofBundle,
  analyzeGpuHmrImageEvidence,
  collectVisualArtifactCasLocators,
  completeAsyncVisualProofJob,
  createAsyncVisualProofJob,
  deterministicVisualModeFromMcpEvidence,
  deterministicVisualModeAccepted,
  evaluateGpuHmrDeterministicVisualMode,
  GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  GPU_HMR_IMAGE_EVIDENCE_MAX_ENCODED_BYTES,
  GPU_HMR_VISUAL_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
  DEFAULT_MCP_FRAME_GATE_TIMEOUT_MS,
  mcpFrameAtOrAfterFrameGate,
  mcpFrameGateSatisfied,
  mcpFrameGateSatisfiedByCaptureChain,
  mcpFrameGateSatisfiedByScreenshot,
  mcpFrameGateForScreenshot,
  mcpScreenshotArgsForFrameGate,
  mcpScreenshotMetadataFromToolResult,
  normalizeGpuHmrDeterministicVisualMode,
  visualArtifactTransportEvidence,
  visualEvidenceRow,
} from '../lib/gpu-hmr-visual-evidence.mjs';

const boundedImageRaw = Buffer.from([
  0, 0, 0, 255,
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255,
]);
const boundedImagePng = await sharp(boundedImageRaw, {
  raw: { width: 2, height: 2, channels: 4 },
}).png().toBuffer();
const boundedImageStats = await analyzeGpuHmrImageEvidence(boundedImagePng, {
  maxEncodedBytes: boundedImagePng.byteLength,
  maxDecodedBytes: 16,
  maxDimension: 2,
  maxPixels: 4,
});
assert.equal(boundedImageStats.width, 2);
assert.equal(boundedImageStats.height, 2);
const mutableImageBytes = Buffer.from(boundedImagePng);
const snapshottedImageAnalysis = analyzeGpuHmrImageEvidence(mutableImageBytes);
mutableImageBytes.fill(0);
assert.equal((await snapshottedImageAnalysis).width, 2);
await assert.rejects(
  analyzeGpuHmrImageEvidence(Buffer.alloc(65), { maxEncodedBytes: 64 }),
  /gpu_hmr_visual_evidence_encoded_byte_limit_exceeded/,
);
await assert.rejects(
  analyzeGpuHmrImageEvidence(boundedImagePng, { maxPixels: 3 }),
  /gpu_hmr_visual_evidence_decoded_pixel_limit_exceeded/,
);
await assert.rejects(
  analyzeGpuHmrImageEvidence(boundedImagePng, { maxDecodedBytes: 15 }),
  /gpu_hmr_visual_evidence_decoded_byte_limit_exceeded/,
);
await assert.rejects(
  analyzeGpuHmrImageEvidence(boundedImagePng, {
    maxEncodedBytes: GPU_HMR_IMAGE_EVIDENCE_MAX_ENCODED_BYTES + 1,
  }),
  /gpu_hmr_visual_evidence_max_encoded_bytes_invalid/,
);
const boundedImagePathRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-visual-input-smoke-'));
const boundedImagePath = path.join(boundedImagePathRoot, 'bounded.png');
await writeFile(boundedImagePath, boundedImagePng);
assert.equal(
  (await analyzeGpuHmrImageEvidence(boundedImagePath, {
    maxEncodedBytes: boundedImagePng.byteLength,
  })).width,
  2,
);

const genericSingleObservation = {
  schema_version: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  output_observation_after_dispatch: true,
  output_observation_ordering_proven: true,
};

assert.equal(deterministicVisualModeAccepted(genericSingleObservation), false);
const genericSingleObservationEvaluation =
  evaluateGpuHmrDeterministicVisualMode(genericSingleObservation);
assert.equal(genericSingleObservationEvaluation.accepted, false);
assert.equal(genericSingleObservationEvaluation.diagnosticAccepted, true);
assert.equal(genericSingleObservationEvaluation.proofMode, 'single_observation_diagnostics');
assert.ok(genericSingleObservationEvaluation.failedGates.some(
  (gate) => gate.code === 'verifier_owned_output_observation_receipt_missing',
));

const legacyRendererPolicy = normalizeGpuHmrDeterministicVisualMode({
  fixed_seed: true,
  seed_policy_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  camera_state_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  frozen_camera: true,
  temporal_accumulation_disabled: true,
  taa_disabled: true,
  denoiser_disabled: true,
  fixed_resolution: true,
  fixed_swapchain_image_count: true,
  warmup_frames: 7,
  frame_capture_after_epoch_dispatch: true,
  presentation_fence_or_frame_boundary: true,
});
assert.equal(legacyRendererPolicy.output_observation_after_dispatch, null);
assert.equal(legacyRendererPolicy.output_observation_ordering_proven, null);
assert.equal(
  evaluateGpuHmrDeterministicVisualMode(legacyRendererPolicy).diagnosticAccepted,
  false,
);
for (const rendererField of [
  'fixed_seed',
  'seed_policy_hash',
  'camera_state_hash',
  'frozen_camera',
  'temporal_accumulation_disabled',
  'taa_disabled',
  'denoiser_disabled',
  'fixed_resolution',
  'fixed_swapchain_image_count',
  'warmup_frames',
  'frame_capture_after_epoch_dispatch',
  'presentation_fence_or_frame_boundary',
]) {
  assert.equal(Object.hasOwn(legacyRendererPolicy, rendererField), false, rendererField);
}

const unfamiliarSourceMetadata = evaluateGpuHmrDeterministicVisualMode({
  ...genericSingleObservation,
  proof_authority: 'unfamiliar-observer@v17',
});
assert.equal(unfamiliarSourceMetadata.accepted, false);
assert.equal(unfamiliarSourceMetadata.diagnosticAccepted, true);

const missingObservationOrdering = evaluateGpuHmrDeterministicVisualMode({
  ...genericSingleObservation,
  output_observation_ordering_proven: false,
});
assert.equal(missingObservationOrdering.accepted, false);
assert.ok(
  missingObservationOrdering.failedGates.some(
    (gate) => gate.code === 'output_observation_ordering_unproven',
  ),
  `expected output_observation_ordering_unproven, got ${missingObservationOrdering.failedGates.map((g) => g.code).join(',')}`,
);

const convergenceWindow = evaluateGpuHmrDeterministicVisualMode({
  schema_version: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  output_observation_after_dispatch: true,
  output_observation_ordering_proven: true,
  convergence_window: {
    sample_start: 3,
    sample_end: 9,
    metric: { value: 'unfamiliar-domain-similarity@v17' },
    sample_count: 7,
    post_dispatch_sample_hashes: [
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      'sha256:5555555555555555555555555555555555555555555555555555555555555555',
      'sha256:6666666666666666666666666666666666666666666666666666666666666666',
      'sha256:7777777777777777777777777777777777777777777777777777777777777777',
    ],
    metric_delta: 12.5,
    convergence_proven: true,
    evidence_refs: ['output-observation:multi-sample'],
  },
});
assert.equal(convergenceWindow.accepted, false);
assert.equal(convergenceWindow.diagnosticAccepted, true);
assert.equal(convergenceWindow.proofMode, 'multi_sample_convergence_diagnostics');

const convergenceWindowWithDeclaredCountOnly = evaluateGpuHmrDeterministicVisualMode({
  schema_version: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  output_observation_after_dispatch: true,
  output_observation_ordering_proven: true,
  convergence_window: {
    sample_start: 3,
    sample_end: 9,
    metric: { value: 'unfamiliar-domain-similarity@v17' },
    sample_count: 7,
    metric_delta: 12.5,
    convergence_proven: true,
    evidence_refs: ['output-observation:multi-sample'],
  },
});
assert.equal(convergenceWindowWithDeclaredCountOnly.accepted, false);
assert.ok(
  convergenceWindowWithDeclaredCountOnly.failedGates.some((gate) =>
    gate.code === 'convergence_sample_evidence_missing'
  ),
  `expected convergence_sample_evidence_missing, got ${convergenceWindowWithDeclaredCountOnly.failedGates.map((g) => g.code).join(',')}`,
);

const artifactHashUsedAsConvergenceSample = evaluateGpuHmrDeterministicVisualMode({
  schema_version: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  output_observation_after_dispatch: true,
  output_observation_ordering_proven: true,
  convergence_window: {
    sample_start: 1,
    sample_end: 2,
    metric: { value: 'unfamiliar-domain-similarity@v17' },
    samples: [
      {
        sample: 1,
        metric_value: 11,
        artifact_hash: 'sha256:8888888888888888888888888888888888888888888888888888888888888888',
        after_dispatch: true,
      },
      {
        sample: 2,
        metric_value: 12,
        artifact_hash: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
        after_dispatch: true,
      },
    ],
    convergence_proven: true,
    evidence_refs: ['output-observation:multi-sample'],
  },
});
assert.equal(artifactHashUsedAsConvergenceSample.accepted, false);
assert.ok(
  artifactHashUsedAsConvergenceSample.failedGates.some((gate) =>
    gate.code === 'convergence_artifact_hash_not_sample_evidence'
  ),
  `expected convergence_artifact_hash_not_sample_evidence, got ${artifactHashUsedAsConvergenceSample.failedGates.map((g) => g.code).join(',')}`,
);

const runtimeArtifactHashUsedAsSampleHash = evaluateGpuHmrDeterministicVisualMode({
  schema_version: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  artifact_hash_after: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  output_observation_after_dispatch: true,
  output_observation_ordering_proven: true,
  convergence_window: {
    sample_start: 1,
    sample_end: 2,
    metric: { value: 'unfamiliar-domain-similarity@v17' },
    observation_hashes: [
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ],
    metric_delta: 12.5,
    convergence_proven: true,
    evidence_refs: ['output-observation:multi-sample'],
  },
});
assert.equal(runtimeArtifactHashUsedAsSampleHash.accepted, false);
assert.ok(
  runtimeArtifactHashUsedAsSampleHash.failedGates.some((gate) =>
    gate.code === 'convergence_sample_hash_matches_gpu_artifact_hash'
  ),
  `expected convergence_sample_hash_matches_gpu_artifact_hash, got ${runtimeArtifactHashUsedAsSampleHash.failedGates.map((g) => g.code).join(',')}`,
);

const missingPostDispatchObservation = evaluateGpuHmrDeterministicVisualMode({
  ...genericSingleObservation,
  output_observation_after_dispatch: false,
});
assert.equal(missingPostDispatchObservation.accepted, false);
assert.ok(
  missingPostDispatchObservation.failedGates.some(
    (gate) => gate.code === 'output_observation_after_dispatch_unproven',
  ),
  `expected output_observation_after_dispatch_unproven, got ${missingPostDispatchObservation.failedGates.map((g) => g.code).join(',')}`,
);

const contradictoryObservationAliases = evaluateGpuHmrDeterministicVisualMode({
  ...genericSingleObservation,
  output_capture_after_dispatch: false,
});
assert.equal(contradictoryObservationAliases.diagnosticAccepted, false);
assert.ok(contradictoryObservationAliases.failedGates.some(
  (gate) => gate.code === 'output_observation_alias_conflict',
));

const duplicateConvergenceSamples = evaluateGpuHmrDeterministicVisualMode({
  ...genericSingleObservation,
  convergence_window: {
    sample_start: 1,
    sample_end: 2,
    metric: { value: 'unfamiliar-domain-similarity@v17' },
    sample_count: 2,
    post_dispatch_sample_hashes: [
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    ],
    metric_delta: 1,
    convergence_proven: true,
    evidence_refs: ['output-observation:duplicate-samples'],
  },
});
assert.equal(duplicateConvergenceSamples.diagnosticAccepted, false);
assert.ok(duplicateConvergenceSamples.failedGates.some(
  (gate) => gate.code === 'convergence_sample_hash_duplicate',
));

assert.equal(mcpFrameGateSatisfied({ status: 'satisfied' }), true);
assert.equal(mcpFrameGateSatisfied({
  frame_gate: { status: 'satisfied' },
  gpu_proof_validation: { satisfied: false },
}), false);
assert.equal(mcpFrameGateSatisfied({ frame_gate: { status: 'timeout' } }), false);
const mcpGate = {
  status: 'satisfied',
  frame_seq: 12,
  ts_ms: 1200,
  session_id: 'runtime-session:visual-smoke',
  gate_token: 'frame-gate:visual-smoke',
};
const mcpAfterScreenshot = {
  seq: 12,
  ts: 1200,
  width: 640,
  height: 480,
  image_sha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  capture_manifest: {
    schema_version: 'synthi.mcp.capture_manifest.v1',
    session_id: 'runtime-session:visual-smoke',
    capture_backend: 'mcp_screenshot',
    capture_event_id: 'screenshot:visual-smoke:12',
    frame_event_id: 7,
    frame_seq: 12,
    frame_ts_ms: 1200,
    source_frame_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    image_sha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    image_byte_length: 1024,
    camera_state_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    camera_state_hash_verified: true,
    camera_state_evidence_authority: 'target_process_runtime_camera_state_attestation',
    camera_state_evidence_ref: 'runtime-camera-state:visual-smoke',
    gate_token: 'frame-gate:visual-smoke',
    gate_token_verified: true,
  },
};
const mcpBeforeScreenshot = {
  seq: 10,
  ts: 1000,
  width: 640,
  height: 480,
  image_sha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  capture_manifest: {
    schema_version: 'synthi.mcp.capture_manifest.v1',
    session_id: 'runtime-session:visual-smoke',
    capture_backend: 'mcp_screenshot',
    capture_event_id: 'screenshot:visual-smoke:10',
    frame_event_id: 5,
    frame_seq: 10,
    frame_ts_ms: 1000,
    source_frame_hash: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    image_sha256: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    image_byte_length: 1024,
    camera_state_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    camera_state_hash_verified: true,
    camera_state_evidence_authority: 'target_process_runtime_camera_state_attestation',
    camera_state_evidence_ref: 'runtime-camera-state:visual-smoke',
  },
};
const mcpSelectedScreenshot = {
  seq: 13,
  ts: 1300,
  width: 640,
  height: 480,
  image_sha256: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  capture_manifest: {
    schema_version: 'synthi.mcp.capture_manifest.v1',
    session_id: 'runtime-session:visual-smoke',
    capture_backend: 'mcp_screenshot',
    capture_event_id: 'screenshot:visual-smoke:13',
    frame_event_id: 8,
    frame_seq: 13,
    frame_ts_ms: 1300,
    source_frame_hash: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
    image_sha256: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    image_byte_length: 1024,
    camera_state_hash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    camera_state_hash_verified: true,
    camera_state_evidence_authority: 'target_process_runtime_camera_state_attestation',
    camera_state_evidence_ref: 'runtime-camera-state:visual-smoke',
    gate_token_verified: false,
  },
};
assert.equal(mcpFrameGateSatisfiedByScreenshot({
  frame_gate: mcpGate,
  gpu_proof_validation: { satisfied: true },
}, mcpAfterScreenshot), true);
assert.equal(mcpFrameGateSatisfiedByCaptureChain({
  frame_gate: mcpGate,
  gpu_proof_validation: { satisfied: true },
}, mcpAfterScreenshot, mcpSelectedScreenshot), true);
assert.equal(mcpFrameGateSatisfiedByCaptureChain({
  frame_gate: mcpGate,
  gpu_proof_validation: { satisfied: true },
}, mcpAfterScreenshot, {
  ...mcpSelectedScreenshot,
  capture_manifest: {
    ...mcpSelectedScreenshot.capture_manifest,
    session_id: 'runtime-session:replayed',
  },
}), false);
assert.equal(mcpFrameGateSatisfiedByCaptureChain({
  frame_gate: mcpGate,
  gpu_proof_validation: { satisfied: true },
}, mcpAfterScreenshot, {
  ...mcpSelectedScreenshot,
  seq: 11,
  ts: 1100,
  capture_manifest: {
    ...mcpSelectedScreenshot.capture_manifest,
    frame_seq: 11,
    frame_ts_ms: 1100,
  },
}), false);
assert.equal(mcpFrameAtOrAfterFrameGate({
  frame_gate: mcpGate,
  gpu_proof_validation: { satisfied: true },
}, {
  seq: 13,
  ts: 1300,
}), true);
assert.equal(mcpFrameAtOrAfterFrameGate({
  frame_gate: mcpGate,
  gpu_proof_validation: { satisfied: true },
}, {
  seq: 11,
  ts: 1300,
}), false);
assert.equal(mcpFrameGateSatisfiedByScreenshot({
  frame_gate: mcpGate,
  gpu_proof_validation: { satisfied: true },
}, { ...mcpAfterScreenshot, seq: 11, ts: 1199 }), false);
assert.deepEqual(mcpFrameGateForScreenshot({
  frame_gate: { ...mcpGate, extra: 'ignored' },
  gpu_proof_validation: { satisfied: true },
}), {
  status: 'satisfied',
  frame_seq: 12,
  ts_ms: 1200,
  gate_token: 'frame-gate:visual-smoke',
  session_id: 'runtime-session:visual-smoke',
});
assert.equal(mcpFrameGateForScreenshot({
  frame_gate: { status: 'event_log_recovered', frame_seq: 12, ts_ms: 1200 },
  gpu_proof_validation: { satisfied: true },
}), null);
assert.equal(mcpFrameGateForScreenshot({
  frame_gate: { status: 'satisfied', frame_seq: 12, ts_ms: 1200 },
  gpu_proof_validation: { satisfied: true },
}), null);
assert.deepEqual(mcpScreenshotArgsForFrameGate({
  frame_gate: mcpGate,
  gpu_proof_validation: { satisfied: true },
}, { freshnessMaxMs: 5000 }), {
  freshness_max_ms: 5000,
  after_frame_gate: {
    status: 'satisfied',
    frame_seq: 12,
    ts_ms: 1200,
    gate_token: 'frame-gate:visual-smoke',
    session_id: 'runtime-session:visual-smoke',
  },
  frame_gate_timeout_ms: DEFAULT_MCP_FRAME_GATE_TIMEOUT_MS,
});
assert.deepEqual(mcpScreenshotArgsForFrameGate({
  frame_gate: { status: 'timeout' },
}, { freshnessMaxMs: 5000, frameGateTimeoutMs: 10 }), {
  freshness_max_ms: 5000,
});
assert.deepEqual(mcpScreenshotMetadataFromToolResult({ json: { seq: 1 } }), { seq: 1 });
assert.deepEqual(mcpScreenshotMetadataFromToolResult({ meta: { seq: 2 } }), { seq: 2 });
assert.deepEqual(mcpScreenshotMetadataFromToolResult({ seq: 3, ts: 3000, data: 'base64' }), {
  seq: 3,
  ts: 3000,
  data: 'base64',
});

const mcpDerived = deterministicVisualModeFromMcpEvidence({
  base: {
    caller_serialized_success: true,
  },
  before: mcpBeforeScreenshot,
  gateCapture: mcpAfterScreenshot,
  after: mcpSelectedScreenshot,
  wait: {
    frame_gate: mcpGate,
    gpu_proof_validation: { satisfied: true },
  },
});
const mcpDerivedEvaluation = evaluateGpuHmrDeterministicVisualMode(mcpDerived);
assert.equal(mcpDerivedEvaluation.accepted, false);
assert.equal(mcpDerivedEvaluation.diagnosticAccepted, true);
assert.equal(mcpDerived.output_observation_after_dispatch, true);
assert.equal(mcpDerived.output_observation_ordering_proven, true);
assert.equal(mcpDerived.evidence_authority, 'verified_mcp_capture_observations_only');
assert.equal(mcpDerived.state_dependency_binding_observed, false);
assert.equal(mcpDerived.caller_serialized_success, undefined);
assert.deepEqual(
  mcpDerivedEvaluation.failedGates.map((gate) => gate.code),
  ['verifier_owned_output_observation_receipt_missing'],
);

const mcpMissingGate = evaluateGpuHmrDeterministicVisualMode(
  deterministicVisualModeFromMcpEvidence({
    before: mcpBeforeScreenshot,
    after: { width: 640, height: 480, seq: 11, ts: 1100 },
    wait: { frame_gate: { status: 'timeout' } },
  }),
);
assert.equal(mcpMissingGate.accepted, false);
assert.ok(
  mcpMissingGate.failedGates.some(
    (gate) => gate.code === 'output_observation_after_dispatch_unproven',
  ),
  `expected output_observation_after_dispatch_unproven, got ${mcpMissingGate.failedGates.map((g) => g.code).join(',')}`,
);

const mcpStaleScreenshot = evaluateGpuHmrDeterministicVisualMode(
  deterministicVisualModeFromMcpEvidence({
    before: mcpBeforeScreenshot,
    after: { ...mcpAfterScreenshot, seq: 11, ts: 1199 },
    wait: {
      frame_gate: mcpGate,
      gpu_proof_validation: { satisfied: true },
    },
  }),
);
assert.equal(mcpStaleScreenshot.accepted, false);
assert.ok(
  mcpStaleScreenshot.failedGates.some((gate) =>
    gate.code === 'output_observation_after_dispatch_unproven'
  ),
  `expected output_observation_after_dispatch_unproven for stale screenshot, got ${mcpStaleScreenshot.failedGates.map((g) => g.code).join(',')}`,
);

const mcpFailedGpuProofValidation = evaluateGpuHmrDeterministicVisualMode(
  deterministicVisualModeFromMcpEvidence({
    before: mcpBeforeScreenshot,
    after: mcpAfterScreenshot,
    wait: {
      frame_gate: mcpGate,
      gpu_proof_validation: { satisfied: false, reason: 'proof_state_below_required' },
    },
  }),
);
assert.equal(mcpFailedGpuProofValidation.accepted, false);
assert.ok(
  mcpFailedGpuProofValidation.failedGates.some((gate) =>
    gate.code === 'output_observation_after_dispatch_unproven'
  ),
  `expected output_observation_after_dispatch_unproven for failed GPU proof validation, got ${mcpFailedGpuProofValidation.failedGates.map((g) => g.code).join(',')}`,
);

const casRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-visual-cas-smoke-'));
const visualLocator = await writeArtifactToCas(Buffer.from('fake-png-bytes-for-transport-only'), {
  artifactRoot: casRoot,
  mediaType: 'image/png',
  artifactKind: 'visual_frame',
  producer: { name: 'visual_smoke', kind: 'self_check' },
  producerSubsystem: 'visual_proof',
  sessionNamespace: 'visual-smoke-session',
  role: 'after_frame',
});
const visualTransport = await visualArtifactTransportEvidence({
  artifactCasLocators: [visualLocator],
}, {
  artifactRoot: casRoot,
  allowedRoots: [casRoot],
  requireReadableBytes: true,
});
assert.equal(
  visualTransport.schemaVersion,
  GPU_HMR_VISUAL_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
);
assert.equal(
  visualTransport.acceptedAsTransportEvidence,
  true,
  JSON.stringify(visualTransport.reasons ?? visualTransport),
);
assert.equal(visualTransport.acceptedForGpuHmr, false);
assert.equal(visualTransport.gpuHmrSuccess, false);
assert.equal(
  visualTransport.proofAuthority,
  'transport_integrity_only_not_visual_or_ledger_proof',
);

const rawReadbackLocator = await writeArtifactToCas(Buffer.from([1, 2, 3, 4]), {
  artifactRoot: casRoot,
  mediaType: 'application/octet-stream',
  artifactKind: 'raw_readback',
  producer: { name: 'visual_smoke', kind: 'self_check' },
  producerSubsystem: 'compute_oracle',
  sessionNamespace: 'visual-smoke-session',
  role: 'raw_readback',
});
assert.equal(
  collectVisualArtifactCasLocators({ artifactCasLocators: [rawReadbackLocator] }).length,
  0,
);
const rawReadbackTransport = await visualArtifactTransportEvidence({
  artifactCasLocators: [rawReadbackLocator],
}, {
  artifactRoot: casRoot,
  allowedRoots: [casRoot],
  requireReadableBytes: true,
});
assert.equal(rawReadbackTransport.accepted, false);
assert.equal(rawReadbackTransport.acceptedAsTransportEvidence, false);
assert.equal(rawReadbackTransport.rejectedNonVisualLocatorCount, 1);
assert.ok(rawReadbackTransport.reasons.includes('non_visual_artifact_transport_locator_rejected'));
assert.ok(rawReadbackTransport.gaps.includes('visual_artifact_transport_requires_image_locator'));

const rowWithTransport = visualEvidenceRow({
  width: 640,
  height: 480,
  visible_pixels: 1000,
  luma_stddev: 5,
  path: visualLocator.storage.localPath,
  artifactCasLocators: [visualLocator],
});
assert.equal(rowWithTransport.accepted_as_visual_evidence, true);
assert.equal(rowWithTransport.artifact_cas_locators.length, 1);
assert.equal(rowWithTransport.artifact_transport_authority, 'transport_integrity_only_not_visual_proof');
assert.equal(collectVisualArtifactCasLocators(rowWithTransport).length, 1);

const bundleDir = await mkdtemp(path.join(os.tmpdir(), 'synthi-visual-proof-bundle-smoke-'));
const beforeBundlePng = path.join(bundleDir, 'before.png');
const afterBundlePng = path.join(bundleDir, 'after.png');
const diffBundlePng = path.join(bundleDir, 'diff.png');
const width = 16;
const height = 16;
const beforeRaw = Buffer.alloc(width * height * 4, 0);
const afterRaw = Buffer.alloc(width * height * 4, 0);
for (let pixel = 0; pixel < width * height; pixel += 1) {
  const offset = pixel * 4;
  beforeRaw[offset] = 20;
  beforeRaw[offset + 1] = 30;
  beforeRaw[offset + 2] = 40;
  beforeRaw[offset + 3] = 255;
  afterRaw[offset] = pixel % 2 === 0 ? 200 : 20;
  afterRaw[offset + 1] = pixel % 2 === 0 ? 180 : 30;
  afterRaw[offset + 2] = pixel % 2 === 0 ? 80 : 40;
  afterRaw[offset + 3] = 255;
}
await sharp(beforeRaw, { raw: { width, height, channels: 4 } }).png().toFile(beforeBundlePng);
await sharp(afterRaw, { raw: { width, height, channels: 4 } }).png().toFile(afterBundlePng);
const bundle = await buildAsyncVisualProofBundle({
  beforePath: beforeBundlePng,
  afterPath: afterBundlePng,
  diffPath: diffBundlePng,
  artifactDir: bundleDir,
  sessionNamespace: 'visual-proof-bundle-smoke',
  producer: { name: 'visual_evidence_smoke', kind: 'self_check' },
  visualProof: { tileSize: 8 },
});
assert.equal(bundle.proofReady, true);
assert.equal(bundle.proofPending, false);
assert.equal(bundle.accepted, true);
assert.equal(bundle.acceptedForGpuHmr, false);
assert.equal(bundle.gpuHmrSuccess, false);
assert.equal(bundle.proofAuthority, 'async_visual_metrics_and_transport_only');
assert.ok(bundle.metrics.changedPixelRatio > 0);
assert.equal(bundle.artifacts.beforeImageHash.startsWith('sha256:'), true);
assert.equal(bundle.artifacts.afterImageHash.startsWith('sha256:'), true);
assert.equal(bundle.artifacts.diffImageHash.startsWith('sha256:'), true);
assert.equal(bundle.artifactCasLocators.length, 3);
assert.equal(bundle.artifactCasLocators.every((locator) => locator.artifactKind === 'visual_frame'), true);
assert.equal(bundle.visualArtifactTransportEvidence.acceptedAsTransportEvidence, true);
assert.equal(bundle.visualArtifactTransportEvidence.acceptedForGpuHmr, false);
assert.equal(bundle.asyncVisualProof.acceptedAsAsyncVisualMetrics, true);

const pendingJob = await createAsyncVisualProofJob({
  beforePath: beforeBundlePng,
  afterPath: afterBundlePng,
  diffPath: path.join(bundleDir, 'pending-diff.png'),
  artifactDir: bundleDir,
  sessionNamespace: 'visual-proof-pending-smoke',
  producer: { name: 'visual_evidence_smoke', kind: 'self_check' },
  visualProof: { tileSize: 8 },
});
assert.equal(pendingJob.schemaVersion, 'synthi.gpu_hmr.async_visual_proof_job.v1');
assert.equal(pendingJob.eventType, 'proof_pending');
assert.equal(pendingJob.proofPending, true);
assert.equal(pendingJob.proofReady, false);
assert.equal(pendingJob.accepted, false);
assert.equal(pendingJob.acceptedAsAsyncVisualProofJob, true);
assert.equal(pendingJob.acceptedForGpuHmr, false);
assert.equal(pendingJob.gpuHmrSuccess, false);
assert.equal(
  pendingJob.proofAuthority,
  'async_visual_job_manifest_only_not_gpu_hmr_acceptance',
);
assert.match(pendingJob.jobHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(pendingJob.jobHash, pendingJob.jobManifestHash);
assert.equal(pendingJob.jobManifestLocator.contentHash, pendingJob.jobHash);
assert.equal(pendingJob.asyncVisualProof.eventType, 'proof_pending');
assert.equal(pendingJob.asyncVisualProof.acceptedAsAsyncVisualMetrics, false);
assert.equal(pendingJob.asyncVisualProof.acceptedForGpuHmr, false);
assert.equal(pendingJob.asyncVisualProof.gpuHmrSuccess, false);
assert.ok(pendingJob.asyncVisualProof.gaps.includes('async_visual_proof_ready_event_missing'));
assert.equal(pendingJob.visualArtifactTransportEvidence.acceptedAsTransportEvidence, true);
assert.equal(pendingJob.artifactCasLocators.length, 2);

await assert.rejects(
  () => completeAsyncVisualProofJob(pendingJob),
  /async_visual_proof_job_completion_requires_trusted_allowed_roots/,
);
const tamperedPendingJob = {
  ...pendingJob,
  request: {
    ...pendingJob.request,
    tileSize: 16,
  },
};
await assert.rejects(
  () => completeAsyncVisualProofJob(tamperedPendingJob, {
    casRoot: pendingJob.casRoot,
    allowedRoots: [pendingJob.casRoot],
    allowedOutputRoots: [bundleDir],
  }),
  /async_visual_proof_job_hash_mismatch/,
);

const completedJob = await completeAsyncVisualProofJob(pendingJob, {
  casRoot: pendingJob.casRoot,
  allowedRoots: [pendingJob.casRoot],
  allowedOutputRoots: [bundleDir],
});
assert.equal(completedJob.proofReady, true);
assert.equal(completedJob.proofPending, false);
assert.equal(completedJob.accepted, true);
assert.equal(completedJob.acceptedForGpuHmr, false);
assert.equal(completedJob.gpuHmrSuccess, false);
assert.equal(completedJob.asyncVisualProof.eventType, 'proof_ready');
assert.equal(completedJob.asyncVisualProof.acceptedAsAsyncVisualMetrics, true);
assert.equal(completedJob.asyncVisualProofJob.jobHash, pendingJob.jobHash);
assert.equal(completedJob.artifactCasLocators.length, 3);
assert.equal(completedJob.visualArtifactTransportEvidence.acceptedAsTransportEvidence, true);

const missingTransport = await visualArtifactTransportEvidence({});
assert.equal(missingTransport.accepted, false);
assert.ok(missingTransport.reasons.includes('visual_artifact_transport_locator_missing'));

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  checkedModes: [
    'single_observation_diagnostics_only',
    'generic_observation_ordering_rejection',
    'open_metric_multi_sample_convergence_diagnostics_only',
    'convergence_declared_count_only_rejection',
    'convergence_duplicate_sample_rejection',
    'convergence_artifact_hash_rejection',
    'convergence_runtime_artifact_hash_collision_rejection',
    'contradictory_observation_alias_rejection',
    'mcp_frame_gate_derived',
    'mcp_screenshot_args_derived',
    'mcp_failed_gpu_proof_validation_rejection',
    'mcp_stale_screenshot_rejection',
    'visual_artifact_transport_evidence_not_gpu_hmr_proof',
    'visual_artifact_transport_rejects_non_visual_cas_locator',
    'async_visual_proof_bundle_cas_worker_transport',
    'async_visual_proof_pending_job_manifest',
  ],
}, null, 2));
