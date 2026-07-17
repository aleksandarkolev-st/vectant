#!/usr/bin/env node

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  GPU_HMR_TEST_TIMING_COMPUTE_ONLY_REASON,
  GPU_HMR_TEST_TIMING_SCHEMA,
  assertCompleteGpuHmrTestTiming,
  deriveGpuHmrTestTimingModality,
  validateGpuHmrTestTiming,
} from '../lib/gpu-hmr-test-timing-v2.mjs';
import {
  attachAgentSplitTestTimingV2,
  buildAgentSplitResultCheckpoint,
  classifyAgentSplitTimingTerminal,
  createAgentSplitTestTimingV2Lifecycle,
  emergencyTimingTerminal,
  finalizeAgentSplitTimingAfterResultPersistence,
  finalizeAgentSplitTimingAfterResultPersistenceSync,
  installAgentSplitEmergencyResultHandlers,
  observedMcpVisualCaptureContract,
  tagAgentSplitTimingError,
} from '../gpu-hmr-agent-split-workspace-test.mjs';

const VISUAL_ORACLE_REQUEST = Object.freeze({ oracleIntent: 'visual_oracle' });
const COMPUTE_ORACLE_REQUEST = Object.freeze({ oracleIntent: 'compute_oracle' });

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

function createCompleteComputeLifecycle(clock) {
  const lifecycle = createAgentSplitTestTimingV2Lifecycle({
    nowNs: clock.now,
    declaredOracleRequest: COMPUTE_ORACLE_REQUEST,
  });
  for (const phaseKey of [
    'cold_intake',
    'discovery',
    'split',
    'compile',
    'load',
    'epoch_publication',
    'dispatch',
    'output_ready',
    'retirement',
  ]) {
    lifecycle.beginPhase(phaseKey);
    clock.tick(2n);
    lifecycle.finishPhase(phaseKey);
  }
  return lifecycle;
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

assert.deepEqual(deriveGpuHmrTestTimingModality(VISUAL_ORACLE_REQUEST), {
  modality: 'visual',
  visualCapable: true,
  notApplicableReason: null,
});
assert.deepEqual(deriveGpuHmrTestTimingModality(COMPUTE_ORACLE_REQUEST), {
  modality: 'compute_only',
  visualCapable: false,
  notApplicableReason: GPU_HMR_TEST_TIMING_COMPUTE_ONLY_REASON,
});
assert.throws(
  () => deriveGpuHmrTestTimingModality({ observed: true, image: 'screenshot-success' }),
  /timing_oracle_modality_undeclared/,
);
assert.throws(
  () => deriveGpuHmrTestTimingModality({
    oracleIntent: 'visual_oracle',
    outputOracleKind: 'compute_oracle',
  }),
  /timing_oracle_modality_conflict/,
);

const visualClock = controlledClock(1_000n);
const visualLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: visualClock.now,
  declaredOracleRequest: VISUAL_ORACLE_REQUEST,
});
assert.equal(visualLifecycle.timingModality, 'visual');
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
  declaredOracleRequest: VISUAL_ORACLE_REQUEST,
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

const undeclaredCaptureClock = controlledClock(2_500n);
const undeclaredCaptureLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: undeclaredCaptureClock.now,
});
assert.throws(
  () => undeclaredCaptureLifecycle.observeCaptureContract(
    captureContract,
    undeclaredCaptureClock.tick(1n),
    undeclaredCaptureClock.tick(1n),
  ),
  /agent_split_timing_modality_not_declared_before_execution/,
);
assert.equal(undeclaredCaptureLifecycle.timingModality, null);
assert.throws(
  () => undeclaredCaptureLifecycle.markNotApplicable(
    'trigger_to_visible',
    GPU_HMR_TEST_TIMING_COMPUTE_ONLY_REASON,
  ),
  /requires_declared_compute_only/,
);

const computeCaptureClock = controlledClock(2_600n);
const computeCaptureLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: computeCaptureClock.now,
  declaredOracleRequest: COMPUTE_ORACLE_REQUEST,
});
assert.throws(
  () => computeCaptureLifecycle.markNotApplicable(
    'trigger_to_visible',
    'capture_happened_to_be_missing',
  ),
  /requires_declared_compute_only/,
);
assert.equal(
  computeCaptureLifecycle.observeCaptureContract(
    captureContract,
    computeCaptureClock.tick(1n),
    computeCaptureClock.tick(1n),
  ),
  false,
);
finishTerminalPhases(computeCaptureLifecycle, computeCaptureClock);
const computeCaptureTiming = computeCaptureLifecycle.finalize({
  outcome: 'refused',
  terminalReason: 'compute_capture_self_check_refused',
});
assert.equal(computeCaptureTiming.visualCapable, false);
for (const phaseKey of ['trigger_to_visible', 'screenshot_capture', 'visual_analysis']) {
  assert.equal(computeCaptureTiming.phases[phaseKey].state, 'not_applicable');
  assert.equal(
    computeCaptureTiming.phases[phaseKey].reasonCode,
    GPU_HMR_TEST_TIMING_COMPUTE_ONLY_REASON,
  );
}

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
  const lifecycle = createAgentSplitTestTimingV2Lifecycle({
    nowNs: clock.now,
    ...(name === 'provider' ? { declaredOracleRequest: VISUAL_ORACLE_REQUEST } : {}),
  });
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
  assert.equal(timing.visualCapable, true);
  for (const phaseKey of ['trigger_to_visible', 'screenshot_capture', 'visual_analysis']) {
    assert.equal(timing.phases[phaseKey].state, 'unavailable');
    assert.notEqual(timing.phases[phaseKey].reasonCode, GPU_HMR_TEST_TIMING_COMPUTE_ONLY_REASON);
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
  declaredOracleRequest: COMPUTE_ORACLE_REQUEST,
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
assert.equal(persistedTiming.resultCheckpoint.testTiming, persistedTiming.testTiming);
assert.equal(persistedTiming.resultCheckpoint.test_timing, persistedTiming.testTiming);
assert.ok(
  BigInt(persistedTiming.testTiming.phases.total_wall.endNs) >= persistedThroughNs,
);

const persistenceFailureClock = controlledClock(6_000n);
const persistenceFailureLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: persistenceFailureClock.now,
  declaredOracleRequest: COMPUTE_ORACLE_REQUEST,
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
assert.equal(
  failedPersistenceTiming.resultCheckpoint.testTiming,
  failedPersistenceTiming.testTiming,
);

const completePassClock = controlledClock(6_500n);
const completePassLifecycle = createCompleteComputeLifecycle(completePassClock);
let attachedCompletePass = null;
const completePassTiming = await finalizeAgentSplitTimingAfterResultPersistence({
  lifecycle: completePassLifecycle,
  timingTerminal: classifyAgentSplitTimingTerminal(),
  persistResults: async () => {
    completePassClock.tick(5n);
  },
  persistAttachedResult: async (bundle) => {
    attachedCompletePass = bundle;
  },
  requireCompleteOnPass: true,
});
assert.equal(completePassTiming.timingTerminal.outcome, 'pass');
assert.equal(completePassTiming.persistenceError, null);
assert.equal(completePassTiming.timingValidationError, null);
assertCompleteGpuHmrTestTiming(completePassTiming.testTiming);
assert.equal(attachedCompletePass.testTiming, completePassTiming.testTiming);
assert.equal(attachedCompletePass.resultCheckpoint.testTiming, completePassTiming.testTiming);
assert.equal(attachedCompletePass.resultCheckpoint.acceptedForGpuHmr, false);
assert.equal(attachedCompletePass.resultCheckpoint.gpuHmrSuccess, false);

const visualTriggerRequiredClock = controlledClock(6_600n);
const visualTriggerRequiredLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: visualTriggerRequiredClock.now,
  declaredOracleRequest: VISUAL_ORACLE_REQUEST,
});
const triggerlessCaptureStartNs = visualTriggerRequiredClock.tick(2n);
const triggerlessCaptureEndNs = visualTriggerRequiredClock.tick(3n);
visualTriggerRequiredLifecycle.observeVisualCapture({
  contract: captureContract,
  captureStartNs: triggerlessCaptureStartNs,
  captureEndNs: triggerlessCaptureEndNs,
  analysisStartNs: triggerlessCaptureEndNs,
  analysisEndNs: visualTriggerRequiredClock.tick(4n),
});
visualTriggerRequiredLifecycle.markUnavailable(
  'retirement',
  'runtime_retirement_boundary_not_observed_in_validator_clock',
);
const visualTriggerRequiredTiming = await finalizeAgentSplitTimingAfterResultPersistence({
  lifecycle: visualTriggerRequiredLifecycle,
  timingTerminal: classifyAgentSplitTimingTerminal(),
  persistResults: async () => {
    visualTriggerRequiredClock.tick(2n);
  },
});
assert.equal(visualTriggerRequiredTiming.timingTerminal.outcome, 'failed');
assert.equal(
  visualTriggerRequiredTiming.timingValidationError?.code,
  'agent_split_visual_trigger_to_visible_incomplete',
);
assert.equal(
  visualTriggerRequiredTiming.testTiming.phases.trigger_to_visible.state,
  'unavailable',
);

const incompleteColdClock = controlledClock(6_700n);
const incompleteColdLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: incompleteColdClock.now,
  declaredOracleRequest: VISUAL_ORACLE_REQUEST,
});
incompleteColdLifecycle.markUnavailable(
  'retirement',
  'runtime_retirement_boundary_not_observed_in_validator_clock',
);
let incompleteColdValidationObserved = false;
let attachedIncompleteCold = null;
const incompleteColdTiming = await finalizeAgentSplitTimingAfterResultPersistence({
  lifecycle: incompleteColdLifecycle,
  timingTerminal: classifyAgentSplitTimingTerminal(),
  persistResults: async () => {
    incompleteColdClock.tick(3n);
  },
  persistAttachedResult: async (bundle) => {
    attachedIncompleteCold = bundle;
  },
  onTimingValidationError: () => {
    incompleteColdValidationObserved = true;
  },
  requireCompleteOnPass: true,
});
assert.equal(incompleteColdValidationObserved, true);
assert.equal(incompleteColdTiming.timingTerminal.outcome, 'failed');
assert.equal(incompleteColdTiming.timingTerminal.category, 'timing_validation_failure');
assert.equal(incompleteColdTiming.testTiming.outcome, 'failed');
assert.ok(incompleteColdTiming.timingValidationError);
assert.equal(validateGpuHmrTestTiming(incompleteColdTiming.testTiming).complete, false);
assert.equal(attachedIncompleteCold.testTiming, incompleteColdTiming.testTiming);
assert.equal(
  attachedIncompleteCold.resultCheckpoint.testTimingTerminal.category,
  'timing_validation_failure',
);

const attachedRefusalClock = controlledClock(6_800n);
const attachedRefusalLifecycle = createAgentSplitTestTimingV2Lifecycle({
  nowNs: attachedRefusalClock.now,
  declaredOracleRequest: VISUAL_ORACLE_REQUEST,
});
attachedRefusalLifecycle.markUnavailable(
  'retirement',
  'runtime_retirement_boundary_not_observed_in_validator_clock',
);
let attachedRefusalBundle = null;
const attachedRefusalTiming = await finalizeAgentSplitTimingAfterResultPersistence({
  lifecycle: attachedRefusalLifecycle,
  timingTerminal: refusalTerminal,
  persistResults: async () => {
    attachedRefusalClock.tick(2n);
  },
  persistAttachedResult: async (bundle) => {
    attachedRefusalBundle = bundle;
  },
  requireCompleteOnPass: true,
});
assert.equal(attachedRefusalTiming.timingTerminal.outcome, 'refused');
assert.equal(attachedRefusalTiming.testTiming.outcome, 'refused');
assert.equal(attachedRefusalBundle.testTiming, attachedRefusalTiming.testTiming);
assert.equal(attachedRefusalBundle.resultCheckpoint.testTiming, attachedRefusalTiming.testTiming);

const attachedWriteFailureClock = controlledClock(6_900n);
const attachedWriteFailureLifecycle = createCompleteComputeLifecycle(attachedWriteFailureClock);
let attachedWriteAttempts = 0;
let attachedWriteErrorsObserved = 0;
const attachedWriteFailureTiming = await finalizeAgentSplitTimingAfterResultPersistence({
  lifecycle: attachedWriteFailureLifecycle,
  timingTerminal: classifyAgentSplitTimingTerminal(),
  persistResults: async () => {
    attachedWriteFailureClock.tick(4n);
  },
  persistAttachedResult: async () => {
    attachedWriteAttempts += 1;
    throw new Error(`self-check attached write failure ${attachedWriteAttempts}`);
  },
  onPersistenceError: () => {
    attachedWriteErrorsObserved += 1;
  },
  requireCompleteOnPass: true,
});
assert.equal(attachedWriteAttempts, 2);
assert.equal(attachedWriteErrorsObserved, 2);
assert.equal(attachedWriteFailureTiming.timingTerminal.outcome, 'failed');
assert.equal(attachedWriteFailureTiming.testTiming.outcome, 'failed');
assert.ok(attachedWriteFailureTiming.attachmentPersistenceError);
assert.ok(attachedWriteFailureTiming.attachmentRetryError);
assert.equal(
  attachedWriteFailureTiming.resultCheckpoint.testTiming,
  attachedWriteFailureTiming.testTiming,
);

const emergencyEventCases = [
  { event: 'SIGINT', payload: null, expectedKind: 'signal:SIGINT' },
  { event: 'SIGTERM', payload: null, expectedKind: 'signal:SIGTERM' },
  {
    event: 'uncaughtException',
    payload: new Error('self-check uncaught detail'),
    expectedKind: 'uncaught_exception',
  },
  {
    event: 'unhandledRejection',
    payload: new Error('self-check rejection detail'),
    expectedKind: 'unhandled_rejection',
  },
];
const retainedEmergencyTimings = [];
for (const emergencyCase of emergencyEventCases) {
  const eventSource = new EventEmitter();
  const routedEvents = [];
  const exitCodes = [];
  installAgentSplitEmergencyResultHandlers({
    eventSource,
    recordEmergency: (kind, detail) => routedEvents.push({ kind, detail }),
    exit: (code) => exitCodes.push(code),
  });
  if (emergencyCase.payload === null) eventSource.emit(emergencyCase.event);
  else eventSource.emit(emergencyCase.event, emergencyCase.payload);
  assert.equal(routedEvents.length, 1);
  assert.equal(routedEvents[0].kind, emergencyCase.expectedKind);
  assert.deepEqual(exitCodes, [1]);

  const emergencyClock = controlledClock(7_000n + BigInt(retainedEmergencyTimings.length * 100));
  const emergencyLifecycle = createAgentSplitTestTimingV2Lifecycle({
    nowNs: emergencyClock.now,
  });
  emergencyLifecycle.beginPhase('discovery');
  emergencyClock.tick(5n);
  emergencyLifecycle.abandonActivePhases();
  emergencyLifecycle.markUnavailable('retirement', 'emergency_retirement_not_observed');
  let emergencyPersistedThroughNs = null;
  let emergencyAttachedBundle = null;
  const emergencyTerminalTiming = finalizeAgentSplitTimingAfterResultPersistenceSync({
    lifecycle: emergencyLifecycle,
    timingTerminal: emergencyTimingTerminal(emergencyCase.expectedKind),
    persistResults: () => {
      emergencyClock.tick(11n);
      emergencyPersistedThroughNs = emergencyClock.now();
    },
    persistAttachedResult: (bundle) => {
      emergencyAttachedBundle = bundle;
    },
  });
  assertSupportOnlyTiming(emergencyTerminalTiming.testTiming, 'failed');
  assert.equal(
    emergencyTerminalTiming.testTiming.phases.discovery.reasonCode,
    'phase_interrupted_by_terminal_event',
  );
  assert.ok(
    BigInt(emergencyTerminalTiming.testTiming.phases.total_wall.endNs)
      >= emergencyPersistedThroughNs,
  );
  assert.equal(emergencyAttachedBundle.testTiming, emergencyTerminalTiming.testTiming);
  assert.equal(
    emergencyAttachedBundle.resultCheckpoint.testTiming,
    emergencyTerminalTiming.testTiming,
  );
  retainedEmergencyTimings.push(emergencyTerminalTiming.testTiming);
}

console.log(JSON.stringify({
  ok: true,
  schema: GPU_HMR_TEST_TIMING_SCHEMA,
  cases: {
    visualModalityUsesDeclaredOracle:
      visualLifecycle.timingModality === 'visual' && visualTiming.visualCapable,
    computeOnlyUsesStableNotApplicableReason:
      computeCaptureTiming.phases.trigger_to_visible.reasonCode
        === GPU_HMR_TEST_TIMING_COMPUTE_ONLY_REASON,
    triggerEndsAtExplicitSignalBeforeCapture:
      visualTiming.phases.trigger_to_visible.endNs === visibleSignalNs.toString(),
    screenshotCannotDeclareModality: undeclaredCaptureLifecycle.timingModality === null,
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
    completePassAttached:
      completePassTiming.resultCheckpoint.testTiming === completePassTiming.testTiming,
    visualPassRequiresMeasuredTrigger:
      visualTriggerRequiredTiming.timingTerminal.outcome === 'failed',
    incompleteColdPassRejected:
      incompleteColdTiming.timingTerminal.category === 'timing_validation_failure',
    ordinaryRefusalAttached:
      attachedRefusalBundle.testTiming === attachedRefusalTiming.testTiming,
    attachedWriteFailureNotSwallowed:
      attachedWriteFailureTiming.timingTerminal.outcome === 'failed'
        && attachedWriteFailureTiming.attachmentPersistenceError !== null,
    terminalEventsRetainTiming:
      retainedEmergencyTimings.length === emergencyEventCases.length,
  },
}, null, 2));
