#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  deterministicVisualModeAccepted,
  evaluateGpuHmrDeterministicVisualMode,
  GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
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
  },
});
assert.equal(convergenceWindow.accepted, true);
assert.equal(convergenceWindow.proofMode, 'convergence_window');

const missingPresentationFence = evaluateGpuHmrDeterministicVisualMode({
  ...deterministicSingleFrame,
  presentation_fence_or_frame_boundary: false,
});
assert.equal(missingPresentationFence.accepted, false);
assert.ok(
  missingPresentationFence.failedGates.some((gate) => gate.code === 'presentation_boundary_unproven'),
  `expected presentation_boundary_unproven, got ${missingPresentationFence.failedGates.map((g) => g.code).join(',')}`,
);

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
  checkedModes: ['single_frame_deterministic', 'swapchain_rejection', 'convergence_window'],
}, null, 2));
