#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  deterministicVisualModeFromMcpEvidence,
  deterministicVisualModeAccepted,
  evaluateGpuHmrDeterministicVisualMode,
  GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  DEFAULT_MCP_FRAME_GATE_TIMEOUT_MS,
  mcpFrameAtOrAfterFrameGate,
  mcpFrameGateSatisfied,
  mcpFrameGateSatisfiedByScreenshot,
  mcpFrameGateForScreenshot,
  mcpScreenshotArgsForFrameGate,
  mcpScreenshotMetadataFromToolResult,
} from '../lib/gpu-hmr-visual-evidence.mjs';

const deterministicSingleFrame = {
  schema_version: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  fixed_seed: true,
  frozen_camera: true,
  temporal_accumulation_disabled: true,
  taa_disabled: true,
  denoiser_disabled: true,
  fixed_resolution: true,
  fixed_swapchain_image_count: true,
  frame_capture_after_epoch_dispatch: true,
  presentation_fence_or_frame_boundary: true,
  warmup_frames: 1,
};

assert.equal(deterministicVisualModeAccepted(deterministicSingleFrame), true);

const missingSwapchainCount = evaluateGpuHmrDeterministicVisualMode({
  ...deterministicSingleFrame,
  fixed_swapchain_image_count: false,
});
assert.equal(missingSwapchainCount.accepted, false);
assert.ok(
  missingSwapchainCount.failedGates.some((gate) => gate.code === 'fixed_swapchain_image_count_unproven'),
  `expected fixed_swapchain_image_count_unproven, got ${missingSwapchainCount.failedGates.map((g) => g.code).join(',')}`,
);

const convergenceWindow = evaluateGpuHmrDeterministicVisualMode({
  schema_version: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  seed_policy_fixed: true,
  frozen_camera: true,
  fixed_resolution: true,
  fixed_swapchain_image_count: true,
  frame_capture_after_epoch_dispatch: true,
  presentation_fence_or_frame_boundary: true,
  temporal_accumulation_present: true,
  taa_present: true,
  denoiser_present: true,
  convergence_window: {
    frame_start: 3,
    frame_end: 9,
    metric: { value: 'window_mean_delta' },
    sample_count: 7,
    metric_delta: 12.5,
    convergence_proven: true,
    evidence_refs: ['visual-window:post-epoch-frames'],
  },
});
assert.equal(convergenceWindow.accepted, true);
assert.equal(convergenceWindow.proofMode, 'convergence_window');

const convergenceWindowWithoutSamples = evaluateGpuHmrDeterministicVisualMode({
  schema_version: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  seed_policy_fixed: true,
  frozen_camera: true,
  fixed_resolution: true,
  fixed_swapchain_image_count: true,
  frame_capture_after_epoch_dispatch: true,
  presentation_fence_or_frame_boundary: true,
  temporal_accumulation_present: true,
  taa_present: true,
  denoiser_present: true,
  convergence_window: {
    frame_start: 3,
    frame_end: 9,
    metric: { value: 'window_mean_delta' },
    metric_delta: 12.5,
    convergence_proven: true,
    evidence_refs: ['visual-window:post-epoch-frames'],
  },
});
assert.equal(convergenceWindowWithoutSamples.accepted, false);
assert.ok(
  convergenceWindowWithoutSamples.failedGates.some((gate) =>
    gate.code === 'convergence_window_sample_evidence_missing'
  ),
  `expected convergence_window_sample_evidence_missing, got ${convergenceWindowWithoutSamples.failedGates.map((g) => g.code).join(',')}`,
);

const convergenceWindowWithoutSeed = evaluateGpuHmrDeterministicVisualMode({
  schema_version: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  frozen_camera: true,
  fixed_resolution: true,
  fixed_swapchain_image_count: true,
  frame_capture_after_epoch_dispatch: true,
  presentation_fence_or_frame_boundary: true,
  temporal_accumulation_present: true,
  taa_present: true,
  denoiser_present: true,
  convergence_window: {
    frame_start: 3,
    frame_end: 4,
    metric: { value: 'per_frame_delta' },
    samples: [
      { frame: 3, metric_value: 10.0, after_epoch_dispatch: true },
      { frame: 4, metric_value: 12.0, after_epoch_dispatch: true },
    ],
    convergence_proven: true,
    evidence_refs: ['visual-window:post-epoch-frames'],
  },
});
assert.equal(convergenceWindowWithoutSeed.accepted, true);
assert.ok(
  convergenceWindowWithoutSeed.warnings.some((warning) =>
    warning.code === 'convergence_window_without_fixed_seed_policy'
  ),
  `expected convergence_window_without_fixed_seed_policy warning, got ${convergenceWindowWithoutSeed.warnings.map((w) => w.code).join(',')}`,
);

const missingPresentationFence = evaluateGpuHmrDeterministicVisualMode({
  ...deterministicSingleFrame,
  presentation_fence_or_frame_boundary: false,
});
assert.equal(missingPresentationFence.accepted, false);
assert.ok(
  missingPresentationFence.failedGates.some((gate) => gate.code === 'presentation_boundary_unproven'),
  `expected presentation_boundary_unproven, got ${missingPresentationFence.failedGates.map((g) => g.code).join(',')}`,
);

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
    gate_token: 'frame-gate:visual-smoke',
    gate_token_verified: true,
  },
};
assert.equal(mcpFrameGateSatisfiedByScreenshot({
  frame_gate: mcpGate,
  gpu_proof_validation: { satisfied: true },
}, mcpAfterScreenshot), true);
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
    fixed_seed: true,
    frozen_camera: true,
    temporal_accumulation_not_applicable: true,
    taa_not_applicable: true,
    denoiser_not_applicable: true,
    fixed_swapchain_image_count: true,
    warmup_frames: 1,
  },
  before: { width: 640, height: 480, seq: 10, ts: 1000 },
  after: mcpAfterScreenshot,
  wait: {
    frame_gate: mcpGate,
    gpu_proof_validation: { satisfied: true },
  },
});
const mcpDerivedEvaluation = evaluateGpuHmrDeterministicVisualMode(mcpDerived);
assert.equal(mcpDerivedEvaluation.accepted, true);
assert.equal(mcpDerived.fixed_resolution, true);
assert.equal(mcpDerived.frame_capture_after_epoch_dispatch, true);
assert.equal(mcpDerived.presentation_fence_or_frame_boundary, true);

const mcpMissingGate = evaluateGpuHmrDeterministicVisualMode(
  deterministicVisualModeFromMcpEvidence({
    base: {
      fixed_seed: true,
      frozen_camera: true,
      temporal_accumulation_not_applicable: true,
      taa_not_applicable: true,
      denoiser_not_applicable: true,
      fixed_swapchain_image_count: true,
    },
    before: { width: 640, height: 480, seq: 10, ts: 1000 },
    after: { width: 640, height: 480, seq: 11, ts: 1100 },
    wait: { frame_gate: { status: 'timeout' } },
  }),
);
assert.equal(mcpMissingGate.accepted, false);
assert.ok(
  mcpMissingGate.failedGates.some((gate) => gate.code === 'frame_capture_after_epoch_dispatch_unproven'),
  `expected frame_capture_after_epoch_dispatch_unproven, got ${mcpMissingGate.failedGates.map((g) => g.code).join(',')}`,
);

const mcpStaleScreenshot = evaluateGpuHmrDeterministicVisualMode(
  deterministicVisualModeFromMcpEvidence({
    base: {
      fixed_seed: true,
      frozen_camera: true,
      temporal_accumulation_not_applicable: true,
      taa_not_applicable: true,
      denoiser_not_applicable: true,
      fixed_swapchain_image_count: true,
    },
    before: { width: 640, height: 480, seq: 10, ts: 1000 },
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
    gate.code === 'frame_capture_after_epoch_dispatch_unproven'
  ),
  `expected frame_capture_after_epoch_dispatch_unproven for stale screenshot, got ${mcpStaleScreenshot.failedGates.map((g) => g.code).join(',')}`,
);

const mcpFailedGpuProofValidation = evaluateGpuHmrDeterministicVisualMode(
  deterministicVisualModeFromMcpEvidence({
    base: {
      fixed_seed: true,
      frozen_camera: true,
      temporal_accumulation_not_applicable: true,
      taa_not_applicable: true,
      denoiser_not_applicable: true,
      fixed_swapchain_image_count: true,
    },
    before: { width: 640, height: 480, seq: 10, ts: 1000 },
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
    gate.code === 'frame_capture_after_epoch_dispatch_unproven'
  ),
  `expected frame_capture_after_epoch_dispatch_unproven for failed GPU proof validation, got ${mcpFailedGpuProofValidation.failedGates.map((g) => g.code).join(',')}`,
);

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  checkedModes: [
    'single_frame_deterministic',
    'swapchain_rejection',
    'convergence_window',
    'convergence_window_sample_rejection',
    'convergence_window_seed_rejection',
    'mcp_frame_gate_derived',
    'mcp_screenshot_args_derived',
    'mcp_failed_gpu_proof_validation_rejection',
    'mcp_stale_screenshot_rejection',
  ],
}, null, 2));
