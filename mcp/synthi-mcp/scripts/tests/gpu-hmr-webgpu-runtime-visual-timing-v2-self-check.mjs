#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  GPU_HMR_TEST_TIMING_SCHEMA,
  validateGpuHmrTestTiming,
} from '../lib/gpu-hmr-test-timing-v2.mjs';
import {
  attachWebgpuRuntimeVisualTestTiming,
  attachWebgpuRuntimeVisualOutcomeTimings,
  buildRetainedWebgpuRuntimeVisualFailure,
  createWebgpuRuntimeVisualTimingV2Recorder,
  finalizeWebgpuRuntimeVisualTimingV2,
  measureWebgpuRuntimeVisualTimingPhase,
} from '../gpu-hmr-webgpu-runtime-visual-proof.mjs';

const RUNTIME_GAP_REASON = 'browser_phase_not_delimited_in_node_monotonic_clock';
const SPLIT_REASON = 'split_not_performed_by_webgpu_runtime_visual_producer';
const VISUAL_NOT_REACHED_REASON = 'visual_phase_not_reached_before_browser';
const RUNTIME_GAP_PHASES = [
  'compile',
  'load',
  'epoch_publication',
  'dispatch',
  'output_ready',
  'retirement',
];

function controlledClock(initialNs = 0n) {
  let currentNs = initialNs;
  return {
    now: () => currentNs,
    tick: (durationNs) => {
      currentNs += durationNs;
      return currentNs;
    },
  };
}

async function measure(recorder, clock, phaseKey, durationNs) {
  return measureWebgpuRuntimeVisualTimingPhase(recorder, phaseKey, async () => {
    clock.tick(durationNs);
  });
}

function assertValidPartialTiming(record, outcome) {
  const validation = validateGpuHmrTestTiming(record);
  assert.equal(record.schema, GPU_HMR_TEST_TIMING_SCHEMA);
  assert.equal(record.outcome, outcome);
  assert.equal(record.acceptedForGpuHmr, false);
  assert.equal(record.gpuHmrSuccess, false);
  assert.equal(record.phases.total_wall.state, 'measured');
  assert.equal(validation.valid, true);
  assert.equal(validation.complete, false);
  return validation;
}

function assertRuntimeClockDomainGaps(record) {
  for (const phaseKey of RUNTIME_GAP_PHASES) {
    assert.deepEqual(record.phases[phaseKey], {
      state: 'unavailable',
      startNs: null,
      endNs: null,
      durationNs: null,
      reasonCode: RUNTIME_GAP_REASON,
    });
  }
}

const passClock = controlledClock();
const passRecorder = createWebgpuRuntimeVisualTimingV2Recorder({ clock: passClock.now });
await measure(passRecorder, passClock, 'cold_intake', 5n);
await measure(passRecorder, passClock, 'discovery', 7n);
passClock.tick(11n);
await measure(passRecorder, passClock, 'trigger_to_visible', 13n);
await measure(passRecorder, passClock, 'screenshot_capture', 17n);
await measure(passRecorder, passClock, 'visual_analysis', 19n);
await measure(passRecorder, passClock, 'proof_finalization', 23n);
const passTiming = finalizeWebgpuRuntimeVisualTimingV2({
  recorder: passRecorder,
  outcome: 'pass',
  visualCapable: true,
  runtimeObserved: true,
});
const passValidation = assertValidPartialTiming(passTiming, 'pass');
assert.equal(passTiming.phases.cold_intake.durationNs, '5');
assert.equal(passTiming.phases.discovery.durationNs, '7');
assert.equal(passTiming.phases.trigger_to_visible.durationNs, '13');
assert.equal(passTiming.phases.screenshot_capture.durationNs, '17');
assert.equal(passTiming.phases.visual_analysis.durationNs, '19');
assert.equal(passTiming.phases.proof_finalization.durationNs, '23');
assert.equal(passTiming.phases.total_wall.durationNs, '95');
assert.equal(
  passTiming.phases.trigger_to_visible.endNs,
  passTiming.phases.screenshot_capture.startNs,
);
assert.deepEqual(passTiming.phases.split, {
  state: 'not_applicable',
  startNs: null,
  endNs: null,
  durationNs: null,
  reasonCode: SPLIT_REASON,
});
assertRuntimeClockDomainGaps(passTiming);
for (const phaseKey of RUNTIME_GAP_PHASES) {
  assert.ok(passValidation.blockingGaps.includes(`phase_unavailable:${phaseKey}`));
}

const proofIdBeforeTiming = 'webgpu-runtime-visual-proof:sha256:canonical-before-timing';
const supportOnlyProof = { proofId: proofIdBeforeTiming, gpuHmrSuccess: true };
attachWebgpuRuntimeVisualTestTiming(supportOnlyProof, passTiming);
assert.equal(supportOnlyProof.proofId, proofIdBeforeTiming);
assert.equal(supportOnlyProof.testTiming, passTiming);
assert.equal(supportOnlyProof.test_timing, passTiming);

for (const forgedTiming of [
  { ...passTiming, authority: 'gpu_hmr_success_authority' },
  { ...passTiming, timingOnly: false },
  { ...passTiming, acceptedForGpuHmr: true },
  { ...passTiming, gpuHmrSuccess: true },
]) {
  assert.throws(
    () => attachWebgpuRuntimeVisualTestTiming({}, forgedTiming),
    /requires valid support-only timing v2/,
  );
}

const coldClock = controlledClock(300n);
const coldRecorder = createWebgpuRuntimeVisualTimingV2Recorder({ clock: coldClock.now });
await measure(coldRecorder, coldClock, 'cold_intake', 2n);
await measure(coldRecorder, coldClock, 'discovery', 3n);
await measure(coldRecorder, coldClock, 'trigger_to_visible', 5n);
await measure(coldRecorder, coldClock, 'screenshot_capture', 7n);
await measure(coldRecorder, coldClock, 'proof_finalization', 11n);
const coldTiming = finalizeWebgpuRuntimeVisualTimingV2({
  recorder: coldRecorder,
  outcome: 'pass',
  visualCapable: true,
  runtimeObserved: true,
  terminalReason: 'cold_visual_analysis_not_executed',
});
const negativeClock = controlledClock(400n);
const negativeRecorder = createWebgpuRuntimeVisualTimingV2Recorder({ clock: negativeClock.now });
await measure(negativeRecorder, negativeClock, 'proof_finalization', 13n);
const negativeTiming = finalizeWebgpuRuntimeVisualTimingV2({
  recorder: negativeRecorder,
  outcome: 'refused',
  visualCapable: false,
  runtimeObserved: false,
  terminalReason: 'negative_edit_rejected_without_runtime_execution',
});
const outcomeArtifacts = {
  proof: {},
  runtimeProofArtifact: {},
  coldArtifact: {},
  hotArtifact: {},
  negativeRefusalArtifact: {},
};
attachWebgpuRuntimeVisualOutcomeTimings({
  ...outcomeArtifacts,
  hotTiming: passTiming,
  coldTiming,
  negativeRefusalTiming: negativeTiming,
});
assert.equal(outcomeArtifacts.proof.testTiming, passTiming);
assert.equal(outcomeArtifacts.runtimeProofArtifact.testTiming, passTiming);
assert.equal(outcomeArtifacts.hotArtifact.testTiming, passTiming);
assert.equal(outcomeArtifacts.coldArtifact.testTiming, coldTiming);
assert.equal(outcomeArtifacts.negativeRefusalArtifact.testTiming, negativeTiming);
assert.notEqual(outcomeArtifacts.coldArtifact.testTiming, outcomeArtifacts.hotArtifact.testTiming);
assert.notEqual(
  outcomeArtifacts.negativeRefusalArtifact.testTiming,
  outcomeArtifacts.hotArtifact.testTiming,
);
assert.equal(coldTiming.phases.trigger_to_visible.endNs, coldTiming.phases.screenshot_capture.startNs);
assert.equal(negativeTiming.phases.trigger_to_visible.state, 'not_applicable');
assert.throws(
  () => attachWebgpuRuntimeVisualOutcomeTimings({
    ...outcomeArtifacts,
    hotTiming: passTiming,
    coldTiming: passTiming,
    negativeRefusalTiming: negativeTiming,
  }),
  /distinct timing records/,
);

const refusalClock = controlledClock(100n);
const refusalRecorder = createWebgpuRuntimeVisualTimingV2Recorder({ clock: refusalClock.now });
await measure(refusalRecorder, refusalClock, 'cold_intake', 3n);
await measure(refusalRecorder, refusalClock, 'discovery', 4n);
await measure(refusalRecorder, refusalClock, 'proof_finalization', 2n);
const refusalTiming = finalizeWebgpuRuntimeVisualTimingV2({
  recorder: refusalRecorder,
  outcome: 'refused',
  visualCapable: false,
  runtimeObserved: false,
  terminalReason: 'webgpu_browser_executable_missing',
});
assertValidPartialTiming(refusalTiming, 'refused');
assert.equal(refusalTiming.phases.total_wall.durationNs, '9');
for (const phaseKey of ['trigger_to_visible', 'screenshot_capture', 'visual_analysis']) {
  assert.deepEqual(refusalTiming.phases[phaseKey], {
    state: 'not_applicable',
    startNs: null,
    endNs: null,
    durationNs: null,
    reasonCode: VISUAL_NOT_REACHED_REASON,
  });
}
for (const phaseKey of RUNTIME_GAP_PHASES) {
  assert.equal(refusalTiming.phases[phaseKey].state, 'unavailable');
  assert.equal(
    refusalTiming.phases[phaseKey].reasonCode,
    'webgpu_browser_executable_missing',
  );
}
const refusalArtifact = buildRetainedWebgpuRuntimeVisualFailure({
  classification: {
    category: 'webgpu_runtime_visual_execution',
    outcome: 'refused',
    code: 'webgpu_browser_executable_missing',
    stage: 'browser_preflight',
  },
  testTiming: refusalTiming,
  generatedAt: '2026-07-16T00:00:00.000Z',
});
assert.equal(refusalArtifact.acceptedForGpuHmr, false);
assert.equal(refusalArtifact.gpuHmrSuccess, false);
assert.equal(refusalArtifact.testTiming, refusalTiming);
assert.equal(refusalArtifact.test_timing, refusalTiming);
assert.equal('message' in refusalArtifact.errorClassification, false);
assert.equal('stack' in refusalArtifact.errorClassification, false);

const failureClock = controlledClock(200n);
const failureRecorder = createWebgpuRuntimeVisualTimingV2Recorder({ clock: failureClock.now });
await measure(failureRecorder, failureClock, 'cold_intake', 2n);
await measure(failureRecorder, failureClock, 'discovery', 3n);
failureClock.tick(5n);
await measure(failureRecorder, failureClock, 'trigger_to_visible', 7n);
await measure(failureRecorder, failureClock, 'screenshot_capture', 11n);
let visualWorkerError = null;
try {
  await measureWebgpuRuntimeVisualTimingPhase(
    failureRecorder,
    'visual_analysis',
    async () => {
      failureClock.tick(13n);
      throw new Error('injected_visual_worker_failure');
    },
  );
} catch (error) {
  visualWorkerError = error;
}
assert.equal(visualWorkerError?.message, 'injected_visual_worker_failure');
await measure(failureRecorder, failureClock, 'proof_finalization', 17n);
const failedTiming = finalizeWebgpuRuntimeVisualTimingV2({
  recorder: failureRecorder,
  outcome: 'failed',
  visualCapable: true,
  runtimeObserved: true,
  terminalReason: 'webgpu_visual_worker_rejected',
});
const failedValidation = assertValidPartialTiming(failedTiming, 'failed');
assert.equal(failedTiming.phases.visual_analysis.state, 'measured');
assert.equal(failedTiming.phases.visual_analysis.durationNs, '13');
assert.equal(failedTiming.phases.proof_finalization.durationNs, '17');
assert.equal(failedTiming.phases.total_wall.durationNs, '58');
assertRuntimeClockDomainGaps(failedTiming);
assert.ok(failedValidation.blockingGaps.includes('phase_unavailable:output_ready'));
const failedArtifact = buildRetainedWebgpuRuntimeVisualFailure({
  classification: {
    category: 'webgpu_runtime_visual_execution',
    outcome: 'failed',
    code: 'webgpu_visual_worker_rejected',
    stage: 'visual_analysis',
  },
  testTiming: failedTiming,
  generatedAt: '2026-07-16T00:00:00.000Z',
});
assert.equal(failedArtifact.errorClassification.code, 'webgpu_visual_worker_rejected');
assert.equal(failedArtifact.errorClassification.errorDetailRetained, false);
assert.equal(JSON.stringify(failedArtifact).includes('injected_visual_worker_failure'), false);

console.log('[ok] WebGPU runtime visual timing v2 self-check passed');
