#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_AUTHORITY,
  GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_SCHEMA_VERSION,
  evaluateRuntimeVisualControlObservationPair,
  runtimeVisualControlObservationHash,
} from '../lib/gpu-hmr-visual-evidence.mjs';

const hash = (character) => `sha256:${character.repeat(64)}`;
const textHash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function observation(phase, overrides = {}) {
  const sourceLine = `[gpu-runtime-boundary] visual_control_observation phase=${phase}`;
  const record = {
    schema_version: GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_SCHEMA_VERSION,
    proof_authority: GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_AUTHORITY,
    phase,
    runtime_session: 'runtime-session:visual-control-self-check',
    process_id: 'pid:4242',
    device_identity: 'device:rocm-self-check',
    capture_event_id: `capture:${phase}`,
    frame_hash: phase === 'before' ? hash('a') : hash('b'),
    width: 640,
    height: 360,
    frame_timestamp_monotonic_ns: phase === 'before' ? '1000' : '3000',
    source_line: sourceLine,
    source_line_hash: textHash(sourceLine),
    source_line_index: phase === 'before' ? 10 : 20,
    dispatch_id: phase === 'after' ? 'dispatch:epoch-2' : null,
    after_epoch_dispatch: phase === 'after',
    capture_synchronized: true,
    presentation_boundary_observed: true,
    fixed_seed: true,
    seed_policy_hash: hash('e'),
    camera_state_hash: hash('f'),
    temporal_accumulation_present: false,
    temporal_accumulation_disabled: false,
    temporal_accumulation_not_applicable: true,
    taa_present: false,
    taa_disabled: false,
    taa_not_applicable: true,
    denoiser_present: false,
    denoiser_disabled: false,
    denoiser_not_applicable: true,
    presentation_image_count: 1,
    warmup_frames: 1,
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    can_satisfy_runtime_proof: false,
    ...overrides,
  };
  return {
    ...record,
    observation_hash: runtimeVisualControlObservationHash(record),
  };
}

const before = observation('before');
const after = observation('after');
const expected = {
  before_frame_hash: before.frame_hash,
  after_frame_hash: after.frame_hash,
  width: 640,
  height: 360,
  process_id: 'pid:4242',
  device_identity: 'device:rocm-self-check',
  runtime_session: 'runtime-session:visual-control-self-check',
  dispatch_id: 'dispatch:epoch-2',
  dispatch_line_index: 15,
  dispatch_timestamp_monotonic_ns: '2000',
};

const accepted = evaluateRuntimeVisualControlObservationPair({ before, after, expected });
assert.equal(accepted.accepted, true);
assert.equal(accepted.acceptedAsRuntimeVisualControlEvidence, true);
assert.equal(accepted.acceptedForGpuHmr, false);
assert.equal(accepted.gpuHmrSuccess, false);
assert.equal(accepted.canSatisfyRuntimeProof, false);
assert.equal(accepted.canSatisfyVisualControlProof, true);
assert.equal(accepted.deterministicVisualModeEvaluation.accepted, true);
assert.equal(accepted.deterministicVisualMode.camera_state_hash, hash('f'));

const forgedPayload = evaluateRuntimeVisualControlObservationPair({
  before,
  after: { ...after, camera_state_hash: hash('9') },
  expected,
});
assert.equal(forgedPayload.accepted, false);
assert.ok(forgedPayload.failedGates.includes(
  'runtime_visual_control_after_observation_hash_mismatch',
));

const replayedSessionAfter = observation('after', { runtime_session: 'runtime-session:replayed' });
const replayedSession = evaluateRuntimeVisualControlObservationPair({
  before,
  after: replayedSessionAfter,
  expected,
});
assert.equal(replayedSession.accepted, false);
assert.ok(replayedSession.failedGates.includes('runtime_visual_control_session_identity_mismatch'));

const authorityClaimAfter = observation('after', { gpu_hmr_success: true });
const authorityClaim = evaluateRuntimeVisualControlObservationPair({
  before,
  after: authorityClaimAfter,
  expected,
});
assert.equal(authorityClaim.accepted, false);
assert.ok(authorityClaim.failedGates.includes('runtime_visual_control_after_authority_claim_invalid'));

const tamperedSourceAfter = observation('after', {
  source_line: '[gpu-runtime-boundary] visual_control_observation phase=after tampered=1',
});
const tamperedSource = evaluateRuntimeVisualControlObservationPair({
  before,
  after: tamperedSourceAfter,
  expected,
});
assert.equal(tamperedSource.accepted, false);
assert.ok(tamperedSource.failedGates.includes(
  'runtime_visual_control_after_source_line_hash_mismatch',
));

const changedDeviceAfter = observation('after', { device_identity: 'device:replayed' });
const changedDevice = evaluateRuntimeVisualControlObservationPair({
  before,
  after: changedDeviceAfter,
  expected,
});
assert.equal(changedDevice.accepted, false);
assert.ok(changedDevice.failedGates.includes('runtime_visual_control_device_identity_mismatch'));

const falseResolutionBefore = observation('before', { width: 320, height: 180 });
const falseResolutionAfter = observation('after', { width: 320, height: 180 });
const falseResolution = evaluateRuntimeVisualControlObservationPair({
  before: falseResolutionBefore,
  after: falseResolutionAfter,
  expected,
});
assert.equal(falseResolution.accepted, false);
assert.ok(falseResolution.failedGates.includes(
  'runtime_visual_control_decoded_resolution_mismatch',
));

const changedSeedAfter = observation('after', { seed_policy_hash: hash('8') });
const changedSeed = evaluateRuntimeVisualControlObservationPair({
  before,
  after: changedSeedAfter,
  expected,
});
assert.equal(changedSeed.accepted, false);
assert.ok(changedSeed.failedGates.includes('runtime_visual_control_seed_policy_changed'));

const temporalEnabledBefore = observation('before', {
  temporal_accumulation_present: true,
  temporal_accumulation_disabled: false,
  temporal_accumulation_not_applicable: false,
});
const temporalEnabledAfter = observation('after', {
  temporal_accumulation_present: true,
  temporal_accumulation_disabled: false,
  temporal_accumulation_not_applicable: false,
});
const temporalEnabled = evaluateRuntimeVisualControlObservationPair({
  before: temporalEnabledBefore,
  after: temporalEnabledAfter,
  expected,
});
assert.equal(temporalEnabled.accepted, false);
assert.ok(temporalEnabled.failedGates.includes(
  'runtime_visual_control_temporal_accumulation_uncontrolled',
));

const wrongFrameHash = evaluateRuntimeVisualControlObservationPair({
  before,
  after,
  expected: { ...expected, after_frame_hash: hash('7') },
});
assert.equal(wrongFrameHash.accepted, false);
assert.ok(wrongFrameHash.failedGates.includes('runtime_visual_control_after_frame_hash_mismatch'));

const preDispatchAfter = observation('after', {
  source_line_index: 14,
  frame_timestamp_monotonic_ns: '1900',
});
const preDispatch = evaluateRuntimeVisualControlObservationPair({
  before,
  after: preDispatchAfter,
  expected,
});
assert.equal(preDispatch.accepted, false);
assert.ok(preDispatch.failedGates.includes('runtime_visual_control_dispatch_line_order_unproven'));
assert.ok(preDispatch.failedGates.includes('runtime_visual_control_dispatch_timestamp_order_unproven'));

console.log(JSON.stringify({
  ok: true,
  schemaVersion: accepted.schemaVersion,
  pairHash: accepted.pairHash,
  acceptedPairDerivesDeterministicMode: accepted.deterministicVisualModeEvaluation.accepted,
  hostileCases: [
    'forged_payload_hash',
    'replayed_session',
    'forged_success_authority',
    'tampered_source_line',
    'changed_device_identity',
    'forged_frame_resolution',
    'changed_seed_policy',
    'temporal_accumulation_enabled',
    'frame_hash_mismatch',
    'pre_dispatch_capture',
  ],
}, null, 2));
