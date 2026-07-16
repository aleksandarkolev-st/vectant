#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  GPU_HMR_TEST_TIMING_AUTHORITY,
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GPU_HMR_TEST_TIMING_PHASE_DEFINITIONS,
  GPU_HMR_TEST_TIMING_SCHEMA,
  GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS,
  GpuHmrTestTimingRecorder,
  assertCompleteGpuHmrTestTiming,
  validateGpuHmrTestTiming,
} from '../lib/gpu-hmr-test-timing-v2.mjs';

assert.deepEqual(GPU_HMR_TEST_TIMING_PHASE_DEFINITIONS.trigger_to_visible, {
  startsAt: 'post_edit_trigger',
  endsAt: 'first_post_edit_visible_or_output_ready_signal',
  excludes: [
    'screenshot_capture',
    'visual_analysis',
    'proof_finalization',
    'total_wall',
  ],
});

function controlledClock(initialNs = 0n) {
  let currentNs = initialNs;
  return {
    now: () => currentNs,
    tick: (durationNs = 1n) => {
      currentNs += durationNs;
      return currentNs;
    },
  };
}

function measure(recorder, clock, phaseKey, durationNs = 1n) {
  recorder.startPhase(phaseKey);
  clock.tick(durationNs);
  return recorder.finishPhase(phaseKey);
}

function nonTotalPhases() {
  return GPU_HMR_TEST_TIMING_PHASE_KEYS.filter((phaseKey) => phaseKey !== 'total_wall');
}

function rewriteMeasuredWindow(record, phaseKey, startNs, endNs) {
  assert.ok(endNs >= startNs);
  record.phases[phaseKey].startNs = startNs.toString();
  record.phases[phaseKey].endNs = endNs.toString();
  record.phases[phaseKey].durationNs = (endNs - startNs).toString();
}

const visualClock = controlledClock();
const visualRecorder = new GpuHmrTestTimingRecorder({ clock: visualClock.now });
for (const phaseKey of nonTotalPhases()) {
  measure(visualRecorder, visualClock, phaseKey, phaseKey === 'cold_intake' ? 0n : 2n);
}
const visualPass = visualRecorder.finalize({
  outcome: 'pass',
  visualCapable: true,
});
const visualPassValidation = validateGpuHmrTestTiming(visualPass);
assert.equal(visualPass.schema, GPU_HMR_TEST_TIMING_SCHEMA);
assert.equal(visualPass.authority, GPU_HMR_TEST_TIMING_AUTHORITY);
assert.equal(visualPass.acceptedForGpuHmr, false);
assert.equal(visualPass.gpuHmrSuccess, false);
assert.deepEqual(Object.keys(visualPass.phases), GPU_HMR_TEST_TIMING_PHASE_KEYS);
assert.equal(visualPass.phases.cold_intake.startNs, '0');
assert.equal(visualPass.phases.cold_intake.endNs, '0');
assert.equal(visualPass.phases.cold_intake.durationNs, '0');
assert.equal(visualPass.phases.total_wall.state, 'measured');
assert.equal(visualPassValidation.valid, true);
assert.equal(visualPassValidation.complete, true);
assert.deepEqual(visualPassValidation.blockingGaps, []);
assertCompleteGpuHmrTestTiming(visualPass);

const nonvisualClock = controlledClock(100n);
const nonvisualRecorder = new GpuHmrTestTimingRecorder({ clock: nonvisualClock.now });
for (const phaseKey of nonTotalPhases()) {
  if (GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.includes(phaseKey)) {
    nonvisualRecorder.notApplicable(phaseKey, 'visual_measurement_not_applicable');
  } else {
    measure(nonvisualRecorder, nonvisualClock, phaseKey);
  }
}
const nonvisualPass = nonvisualRecorder.finalize({
  outcome: 'pass',
  visualCapable: false,
});
const nonvisualPassValidation = validateGpuHmrTestTiming(nonvisualPass);
assert.equal(nonvisualPassValidation.valid, true);
assert.equal(nonvisualPassValidation.complete, true);
for (const phaseKey of GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS) {
  const phase = nonvisualPass.phases[phaseKey];
  assert.equal(phase.state, 'not_applicable');
  assert.equal(phase.startNs, null);
  assert.equal(phase.endNs, null);
  assert.equal(phase.durationNs, null);
  assert.equal(phase.reasonCode, 'visual_measurement_not_applicable');
}

const positionalClock = controlledClock(150n);
const positionalRecorder = new GpuHmrTestTimingRecorder({ clock: positionalClock.now });
for (const phaseKey of nonTotalPhases()) {
  measure(positionalRecorder, positionalClock, phaseKey);
}
assert.equal(positionalRecorder.finalize('pass', true).complete, true);

const refusalClock = controlledClock(200n);
const refusalRecorder = new GpuHmrTestTimingRecorder({ clock: refusalClock.now });
measure(refusalRecorder, refusalClock, 'cold_intake');
measure(refusalRecorder, refusalClock, 'discovery');
refusalRecorder.unavailable('split', 'request_refused');
const refusal = refusalRecorder.finalize({
  outcome: 'refused',
  visualCapable: false,
  terminalReason: 'request_refused',
  notApplicableReason: 'visual_measurement_not_applicable',
});
const refusalValidation = validateGpuHmrTestTiming(refusal);
assert.equal(refusal.outcome, 'refused');
assert.equal(refusal.phases.compile.state, 'unavailable');
assert.equal(refusal.phases.compile.reasonCode, 'request_refused');
assert.equal(refusal.phases.total_wall.state, 'measured');
assert.deepEqual(Object.keys(refusal.phases), GPU_HMR_TEST_TIMING_PHASE_KEYS);
for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
  assert.notEqual(refusal.phases[phaseKey], undefined);
}
assert.equal(refusalValidation.valid, true);
assert.equal(refusalValidation.complete, false);
assert.ok(refusalValidation.blockingGaps.includes('phase_unavailable:compile'));

const failureClock = controlledClock(300n);
const failureRecorder = new GpuHmrTestTimingRecorder({ clock: failureClock.now });
let thrownFailure;
try {
  failureRecorder.startPhase('cold_intake');
  failureClock.tick(5n);
  throw new Error('injected_failure');
} catch {
  thrownFailure = failureRecorder.finalize({
    outcome: 'failed',
    visualCapable: true,
    terminalReason: 'exception_raised',
  });
}
assert.equal(thrownFailure.outcome, 'failed');
assert.equal(thrownFailure.phases.cold_intake.state, 'measured');
assert.equal(thrownFailure.phases.cold_intake.startNs, '300');
assert.equal(thrownFailure.phases.cold_intake.endNs, '305');
assert.equal(thrownFailure.phases.cold_intake.durationNs, '5');
assert.equal(thrownFailure.phases.cold_intake.reasonCode, null);
assert.equal(thrownFailure.phases.total_wall.state, 'measured');
assert.equal(thrownFailure.phases.total_wall.startNs, '300');
assert.equal(thrownFailure.phases.total_wall.endNs, '305');
assert.equal(thrownFailure.phases.total_wall.durationNs, '5');
assert.deepEqual(Object.keys(thrownFailure.phases), GPU_HMR_TEST_TIMING_PHASE_KEYS);
for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
  assert.notEqual(thrownFailure.phases[phaseKey], undefined);
}
const thrownFailureValidation = validateGpuHmrTestTiming(thrownFailure);
assert.equal(thrownFailure.complete, false);
assert.equal(thrownFailureValidation.valid, true);
assert.equal(thrownFailureValidation.complete, false);
assert.ok(thrownFailureValidation.blockingGaps.includes('phase_unavailable:compile'));

const missingVisualClock = controlledClock(400n);
const missingVisualRecorder = new GpuHmrTestTimingRecorder({ clock: missingVisualClock.now });
for (const phaseKey of nonTotalPhases()) {
  if (phaseKey !== 'trigger_to_visible') {
    measure(missingVisualRecorder, missingVisualClock, phaseKey);
  }
}
const missingVisual = missingVisualRecorder.finalize({
  outcome: 'pass',
  visualCapable: true,
  terminalReason: 'measurement_not_observed',
});
const missingVisualValidation = validateGpuHmrTestTiming(missingVisual);
assert.equal(missingVisualValidation.valid, true);
assert.equal(missingVisualValidation.complete, false);
assert.equal(missingVisualValidation.ok, false);
assert.ok(missingVisualValidation.blockingGaps.includes(
  'visual_phase_not_measured:trigger_to_visible',
));
assert.throws(
  () => assertCompleteGpuHmrTestTiming(missingVisual),
  (error) => error?.code === 'timing_record_incomplete',
);

const duplicateClock = controlledClock(500n);
const duplicateRecorder = new GpuHmrTestTimingRecorder({ clock: duplicateClock.now });
duplicateRecorder.startPhase('discovery');
assert.throws(
  () => duplicateRecorder.startPhase('discovery'),
  (error) => error?.code === 'timing_phase_transition_invalid',
);
duplicateClock.tick();
duplicateRecorder.finishPhase('discovery');
assert.throws(
  () => duplicateRecorder.finishPhase('discovery'),
  (error) => error?.code === 'timing_phase_transition_invalid',
);
const duplicateFailure = duplicateRecorder.finalize({
  outcome: 'failed',
  visualCapable: false,
  terminalReason: 'duplicate_transition_rejected',
  notApplicableReason: 'visual_measurement_not_applicable',
});
assert.equal(duplicateFailure.phases.total_wall.state, 'measured');
assert.throws(
  () => duplicateRecorder.finalize({
    outcome: 'failed',
    visualCapable: false,
    terminalReason: 'duplicate_transition_rejected',
  }),
  (error) => error?.code === 'timing_recorder_finalized',
);

const timestampForgery = JSON.parse(JSON.stringify(visualPass));
const forgedCompileStart = BigInt(timestampForgery.phases.compile.startNs);
timestampForgery.phases.compile.endNs = (forgedCompileStart - 1n).toString();
timestampForgery.phases.compile.durationNs = '0';
const timestampForgeryValidation = validateGpuHmrTestTiming(timestampForgery);
assert.equal(timestampForgeryValidation.valid, false);
assert.equal(timestampForgeryValidation.complete, false);
assert.ok(timestampForgeryValidation.blockingGaps.includes(
  'phase_timestamp_order_invalid:compile',
));

const overlappingWork = JSON.parse(JSON.stringify(visualPass));
rewriteMeasuredWindow(overlappingWork, 'discovery', 0n, 5n);
rewriteMeasuredWindow(overlappingWork, 'split', 1n, 5n);
rewriteMeasuredWindow(overlappingWork, 'compile', 2n, 6n);
const overlappingWorkValidation = validateGpuHmrTestTiming(overlappingWork);
assert.equal(overlappingWorkValidation.valid, true);
assert.equal(overlappingWorkValidation.complete, true);

const compileLoadForgery = JSON.parse(JSON.stringify(visualPass));
const compileEndNs = BigInt(compileLoadForgery.phases.compile.endNs);
const loadEndNs = BigInt(compileLoadForgery.phases.load.endNs);
rewriteMeasuredWindow(compileLoadForgery, 'load', compileEndNs - 1n, loadEndNs);
const compileLoadForgeryValidation = validateGpuHmrTestTiming(compileLoadForgery);
assert.equal(compileLoadForgeryValidation.valid, false);
assert.ok(compileLoadForgeryValidation.blockingGaps.includes(
  'phase_causal_order_invalid:compile:load',
));

const captureAnalysisForgery = JSON.parse(JSON.stringify(visualPass));
const captureEndNs = BigInt(captureAnalysisForgery.phases.screenshot_capture.endNs);
const analysisEndNs = BigInt(captureAnalysisForgery.phases.visual_analysis.endNs);
rewriteMeasuredWindow(
  captureAnalysisForgery,
  'visual_analysis',
  captureEndNs - 1n,
  analysisEndNs,
);
const captureAnalysisForgeryValidation = validateGpuHmrTestTiming(captureAnalysisForgery);
assert.equal(captureAnalysisForgeryValidation.valid, false);
assert.ok(captureAnalysisForgeryValidation.blockingGaps.includes(
  'phase_causal_order_invalid:screenshot_capture:visual_analysis',
));

const proofFinalizationForgery = JSON.parse(JSON.stringify(visualPass));
rewriteMeasuredWindow(proofFinalizationForgery, 'proof_finalization', 0n, 1n);
const proofFinalizationForgeryValidation = validateGpuHmrTestTiming(
  proofFinalizationForgery,
);
assert.equal(proofFinalizationForgeryValidation.valid, false);
for (const predecessorKey of ['retirement', 'output_ready', 'visual_analysis']) {
  assert.ok(proofFinalizationForgeryValidation.blockingGaps.includes(
    `proof_finalization_finish_order_invalid:${predecessorKey}`,
  ));
}

const authorityForgery = JSON.parse(JSON.stringify(visualPass));
authorityForgery.authority = 'success_authority';
authorityForgery.acceptedForGpuHmr = true;
authorityForgery.gpuHmrSuccess = true;
authorityForgery.success = true;
const authorityForgeryValidation = validateGpuHmrTestTiming(authorityForgery);
assert.equal(authorityForgeryValidation.valid, false);
assert.equal(authorityForgeryValidation.complete, false);
assert.ok(authorityForgeryValidation.blockingGaps.includes('timing_authority_invalid'));
assert.ok(authorityForgeryValidation.blockingGaps.includes(
  'accepted_for_gpu_hmr_must_be_false',
));
assert.ok(authorityForgeryValidation.blockingGaps.includes(
  'gpu_hmr_success_must_be_false',
));
assert.ok(authorityForgeryValidation.blockingGaps.includes(
  'record_field_unexpected:success',
));

console.log(JSON.stringify({
  ok: true,
  schema: GPU_HMR_TEST_TIMING_SCHEMA,
  cases: {
    visualPass: visualPassValidation.complete,
    nonvisualPass: nonvisualPassValidation.complete,
    refusalBeforeCompile: refusalValidation.valid && !refusalValidation.complete,
    thrownFailureClosedTotal: thrownFailure.phases.total_wall.state === 'measured',
    missingVisualRejected: !missingVisualValidation.complete,
    duplicateTransitionRejected: duplicateFailure.outcome === 'failed',
    timestampForgeryRejected: !timestampForgeryValidation.valid,
    overlappingWorkAccepted: overlappingWorkValidation.complete,
    causalTimestampForgeriesRejected:
      !compileLoadForgeryValidation.valid
      && !captureAnalysisForgeryValidation.valid
      && !proofFinalizationForgeryValidation.valid,
    authorityForgeryRejected: !authorityForgeryValidation.valid,
  },
}, null, 2));
