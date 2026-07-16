#!/usr/bin/env node

import assert from 'node:assert/strict';
import {
  GPU_HMR_TEST_TIMING_SCHEMA,
  validateGpuHmrTestTiming,
} from '../lib/gpu-hmr-test-timing-v2.mjs';
import {
  attachAgentSplitTestTimingV2,
  buildAgentSplitResultCheckpoint,
  classifyAgentSplitTimingTerminal,
  createAgentSplitTestTimingV2Lifecycle,
  emergencyTimingTerminal,
  finalizeAgentSplitTimingAfterResultPersistence,
  observedMcpVisualCaptureContract,
  tagAgentSplitTimingError,
} from '../gpu-hmr-agent-split-workspace-test.mjs';

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

function finishTerminalPhases(lifecycle, clock) {
  lifecycle.markUnavailable(
    'retirement',
    'runtime_retirement_boundary_not_observed_in_validator_clock',
  );
  lifecycle.beginPhase('proof_finalization');
  clock.tick(7n);
  lifecycle.finishPhase('proof_finalization');
}

function assertSupportOnlyTiming(record, outcome) {
  const validation = validateGpuHmrTestTiming(record);
  assert.equal(record.schema, GPU_HMR_TEST_TIMING_SCHEMA);
  assert.equal(record.outcome, outcome);
  assert.equal(record.authority, 'timing_only');
  assert.equal(record.timingOnly, true);
  assert.equal(record.acceptedForGpuHmr, false);
  assert.equal(record.gpuHmrSuccess, false);
  assert.equal(record.phases.total_wall.state, 'measured');
  assert.equal(validation.valid, true);
  return validation;
}

const visualClock = controlledClock(1_000n);
const visualLifecycle = createAgentSplitTestTimingV2Lifecycle({ nowNs: visualClock.now });
visualLifecycle.beginPhase('cold_intake');
visualClock.tick(5n);
visualLifecycle.beginPhase('discovery');
visualClock.tick(7n);
visualLifecycle.finishPhase('discovery');
visualClock.tick(3n);
visualLifecycle.finishPhase('cold_intake');

const editTriggerNs = visualClock.tick(2n);
visualLifecycle.observeEditTrigger(editTriggerNs);
visualClock.tick(13n);
visualLifecycle.observeOpaqueCompileRequest();
visualLifecycle.observeRuntimeWait();
visualClock.tick(18n);
const visibleSignalNs = visualClock.tick(2n);
assert.equal(
  visualLifecycle.observePostEditVisibleOrOutputReadySignal(visibleSignalNs),
  true,
);

const captureResult = {
  profileId: 'name_must_not_enable_visual_timing',
  fixture: 'name_must_not_enable_visual_timing',
  json: {
    w: 640,
    h: 480,
    seq: 42,
    ts: 1234,
    capture_manifest: { session_id: 'self-check', verified: true },
  },
  content: [{ type: 'image', data: 'c2VsZi1jaGVjay1pbWFnZQ==' }],
};
const captureContract = observedMcpVisualCaptureContract(captureResult);
assert.equal(captureContract.observed, true);
const captureStartNs = visualClock.tick(3n);
const captureEndNs = visualClock.tick(19n);
visualLifecycle.observeCaptureContract(captureContract, captureStartNs, captureEndNs);
const analysisStartNs = captureEndNs;
const analysisEndNs = visualClock.tick(23n);
visualLifecycle.observeVisualCapture({
  contract: captureContract,
  captureStartNs,
  captureEndNs,
  analysisStartNs,
  analysisEndNs,
});
finishTerminalPhases(visualLifecycle, visualClock);
const visualTiming = visualLifecycle.finalize({ outcome: 'pass' });
const visualValidation = assertSupportOnlyTiming(visualTiming, 'pass');
assert.equal(visualTiming.visualCapable, true);
assert.equal(visualTiming.phases.trigger_to_visible.startNs, editTriggerNs.toString());
assert.equal(visualTiming.phases.trigger_to_visible.endNs, visibleSignalNs.toString());
assert.equal(
  visualTiming.phases.trigger_to_visible.durationNs,
  (visibleSignalNs - editTriggerNs).toString(),
);
assert.ok(
  BigInt(visualTiming.phases.trigger_to_visible.endNs)
    < BigInt(visualTiming.phases.screenshot_capture.startNs),
);
assert.equal(visualTiming.phases.screenshot_capture.durationNs, '19');
assert.equal(visualTiming.phases.visual_analysis.durationNs, '23');
assert.equal(
  visualTiming.phases.screenshot_capture.endNs,
  visualTiming.phases.visual_analysis.startNs,
);
assert.ok(visualValidation.blockingGaps.includes('phase_unavailable:load'));
assert.ok(visualValidation.blockingGaps.includes('phase_unavailable:epoch_publication'));
assert.ok(visualValidation.blockingGaps.includes('phase_unavailable:dispatch'));
assert.equal(
  visualTiming.phases.split.reasonCode,
  'split_boundary_not_observed_in_validator_clock',
);
assert.equal(
  visualTiming.phases.compile.reasonCode,
  'compile_boundary_not_observed_in_validator_clock',
);
assert.equal(visualTiming.phases.output_ready.reasonCode, 'output_ready_signal_not_observed');
assert.equal(
  visualTiming.phases.retirement.reasonCode,
  'runtime_retirement_boundary_not_observed_in_validator_clock',
);

const proofIdentity = 'agent-split-run-mode-proof:self-check';
const supportOnlyProof = { proofId: proofIdentity, gpuHmrSuccess: true };
attachAgentSplitTestTimingV2(supportOnlyProof, visualTiming);
assert.equal(supportOnlyProof.proofId, proofIdentity);
assert.equal(supportOnlyProof.gpuHmrSuccess, true);
assert.equal(supportOnlyProof.testTiming, visualTiming);
assert.equal(supportOnlyProof.test_timing, visualTiming);

for (const [field, forgedValue] of [
  ['authority', 'gpu_hmr_success_authority'],
  ['timingOnly', false],
  ['acceptedForGpuHmr', true],
  ['gpuHmrSuccess', true],
]) {
  const forgedTiming = structuredClone(visualTiming);
  forgedTiming[field] = forgedValue;
  assert.throws(
    () => attachAgentSplitTestTimingV2({}, forgedTiming),
    /valid support-only record|cannot carry GPU HMR authority/,
    `forged timing field ${field} must be rejected`,
  );
}

const unavailableClock = controlledClock(2_000n);
const unavailableLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: unavailableClock.now,
});
const unavailableTriggerNs = unavailableClock.tick(2n);
unavailableLifecycle.observeEditTrigger(unavailableTriggerNs);
const unavailableCaptureStartNs = unavailableClock.tick(3n);
const unavailableCaptureEndNs = unavailableClock.tick(11n);
const unavailableAnalysisEndNs = unavailableClock.tick(13n);
unavailableLifecycle.observeVisualCapture({
  contract: captureContract,
  captureStartNs: unavailableCaptureStartNs,
  captureEndNs: unavailableCaptureEndNs,
  analysisStartNs: unavailableCaptureEndNs,
  analysisEndNs: unavailableAnalysisEndNs,
});
finishTerminalPhases(unavailableLifecycle, unavailableClock);
const refusalTerminal = classifyAgentSplitTimingTerminal(
  tagAgentSplitTimingError(new Error('self-check refusal detail'), {
    outcome: 'refused',
    category: 'proof_refusal',
    reasonCode: 'agent_split_visual_frame_refused',
  }),
);
const unavailableTiming = unavailableLifecycle.finalize({
  outcome: refusalTerminal.outcome,
  terminalReason: refusalTerminal.reasonCode,
});
assertSupportOnlyTiming(unavailableTiming, 'refused');
assert.equal(unavailableTiming.visualCapable, true);
assert.deepEqual(unavailableTiming.phases.trigger_to_visible, {
  state: 'unavailable',
  startNs: null,
  endNs: null,
  durationNs: null,
  reasonCode: 'first_post_epoch_visible_frame_not_observed',
});
assert.equal(unavailableTiming.phases.screenshot_capture.state, 'measured');
assert.equal(unavailableTiming.phases.visual_analysis.state, 'measured');

const nameOnlyContract = observedMcpVisualCaptureContract({
  profileId: 'visual-profile-name-only',
  fixture: 'visual-fixture-name-only',
  projectName: 'visual-project-name-only',
  json: { w: 640, h: 480 },
  content: [{ type: 'text', text: 'not an observed image capture' }],
});
assert.equal(nameOnlyContract.observed, false);

const providerTerminal = classifyAgentSplitTimingTerminal(
  tagAgentSplitTimingError(new Error('provider secret must not be retained'), {
    outcome: 'failed',
    category: 'provider_failure',
    reasonCode: 'agent_split_ai_provider_failure',
  }),
);
const runtimeTerminal = classifyAgentSplitTimingTerminal(new Error('runtime stack detail'));
const emergencyTerminal = emergencyTimingTerminal('signal:SIGTERM');
const structuredRefusal = classifyAgentSplitTimingTerminal({
  waitSummary: { status: 'rejected' },
});
assert.deepEqual(classifyAgentSplitTimingTerminal(), {
  outcome: 'pass',
  category: 'success',
  reasonCode: null,
});
assert.equal(providerTerminal.category, 'provider_failure');
assert.equal(providerTerminal.outcome, 'failed');
assert.equal(runtimeTerminal.category, 'runtime_failure');
assert.equal(runtimeTerminal.outcome, 'failed');
assert.equal(emergencyTerminal.category, 'emergency_failure');
assert.equal(emergencyTerminal.reasonCode, 'agent_split_emergency_sigterm');
assert.equal(structuredRefusal.outcome, 'refused');

for (const [name, terminal] of [
  ['provider', providerTerminal],
  ['runtime', runtimeTerminal],
  ['emergency', emergencyTerminal],
]) {
  const clock = controlledClock(3_000n);
  const lifecycle = createAgentSplitTestTimingV2Lifecycle({ nowNs: clock.now });
  if (name === 'provider') {
    clock.tick(7n);
    lifecycle.observeOpaqueCompileRequest();
  }
  if (name === 'emergency') {
    lifecycle.markUnavailable('retirement', 'emergency_retirement_not_observed');
    lifecycle.beginPhase('proof_finalization');
    clock.tick(3n);
    lifecycle.finishPhase('proof_finalization');
  } else {
    finishTerminalPhases(lifecycle, clock);
  }
  const timing = lifecycle.finalize({
    outcome: terminal.outcome,
    terminalReason: terminal.reasonCode,
  });
  assertSupportOnlyTiming(timing, 'failed');
  assert.equal(timing.visualCapable, false);
  for (const phaseKey of ['trigger_to_visible', 'screenshot_capture', 'visual_analysis']) {
    assert.equal(timing.phases[phaseKey].state, 'not_applicable');
    assert.equal(
      timing.phases[phaseKey].reasonCode,
      'visual_capture_contract_not_observed',
    );
  }
  const checkpoint = buildAgentSplitResultCheckpoint({
    reason: `${name}_terminal`,
    rows: [{ status: 'fail' }],
    testTiming: timing,
    timingTerminal: terminal,
    slug: `self-check-${name}`,
    updatedAt: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(checkpoint.acceptedForGpuHmr, false);
  assert.equal(checkpoint.gpuHmrSuccess, false);
  assert.equal(checkpoint.testTiming, timing);
  assert.equal(checkpoint.test_timing, timing);
  assert.equal(checkpoint.testTimingTerminal.category, terminal.category);
  assert.equal(JSON.stringify(checkpoint).includes('provider secret'), false);
  assert.equal(JSON.stringify(checkpoint).includes('runtime stack'), false);
}

const persistenceClock = controlledClock(5_000n);
const persistenceLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: persistenceClock.now,
});
persistenceLifecycle.markUnavailable(
  'retirement',
  'runtime_retirement_boundary_not_observed_in_validator_clock',
);
let persistedThroughNs = null;
const persistedTiming = await finalizeAgentSplitTimingAfterResultPersistence({
  lifecycle: persistenceLifecycle,
  timingTerminal: classifyAgentSplitTimingTerminal(),
  persistResults: async () => {
    persistenceClock.tick(31n);
    persistedThroughNs = persistenceClock.now();
  },
});
assertSupportOnlyTiming(persistedTiming.testTiming, 'pass');
assert.equal(persistedTiming.persistenceError, null);
assert.equal(persistedTiming.testTiming.phases.proof_finalization.durationNs, '31');
assert.ok(
  BigInt(persistedTiming.testTiming.phases.total_wall.endNs) >= persistedThroughNs,
);

const persistenceFailureClock = controlledClock(6_000n);
const persistenceFailureLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: persistenceFailureClock.now,
});
persistenceFailureLifecycle.markUnavailable(
  'retirement',
  'runtime_retirement_boundary_not_observed_in_validator_clock',
);
let persistenceFailureObserved = false;
const failedPersistenceTiming = await finalizeAgentSplitTimingAfterResultPersistence({
  lifecycle: persistenceFailureLifecycle,
  timingTerminal: classifyAgentSplitTimingTerminal(),
  persistResults: async () => {
    persistenceFailureClock.tick(17n);
    throw new Error('self-check persistence failure detail');
  },
  onPersistenceError: () => {
    persistenceFailureObserved = true;
  },
});
assert.equal(persistenceFailureObserved, true);
assert.equal(failedPersistenceTiming.timingTerminal.outcome, 'failed');
assert.equal(
  failedPersistenceTiming.timingTerminal.reasonCode,
  'agent_split_result_persistence_failure',
);
assertSupportOnlyTiming(failedPersistenceTiming.testTiming, 'failed');

console.log(JSON.stringify({
  ok: true,
  schema: GPU_HMR_TEST_TIMING_SCHEMA,
  cases: {
    visualPassUsesObservedContract: visualTiming.visualCapable,
    triggerEndsAtExplicitSignalBeforeCapture:
      visualTiming.phases.trigger_to_visible.endNs === visibleSignalNs.toString(),
    screenshotCannotBecomeVisibleSignal:
      unavailableTiming.phases.trigger_to_visible.state === 'unavailable',
    missingCausalFrameUnavailable:
      unavailableTiming.phases.trigger_to_visible.state === 'unavailable',
    namesDoNotEnableVisualCapability: nameOnlyContract.observed === false,
    refusalRetained: unavailableTiming.outcome === 'refused',
    providerFailureRetained: providerTerminal.category === 'provider_failure',
    runtimeFailureRetained: runtimeTerminal.category === 'runtime_failure',
    emergencyFailureRetained: emergencyTerminal.category === 'emergency_failure',
    totalWallIncludesResultPersistence:
      BigInt(persistedTiming.testTiming.phases.total_wall.endNs) >= persistedThroughNs,
    persistenceFailureRetained:
      failedPersistenceTiming.testTiming.outcome === 'failed',
  },
}, null, 2));
