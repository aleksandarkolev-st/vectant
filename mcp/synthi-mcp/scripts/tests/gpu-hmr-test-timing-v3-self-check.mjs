#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  GPU_HMR_TEST_TIMING_V3_ABSENT_ARTIFACT_KIND,
  GPU_HMR_TEST_TIMING_V3_ABSENT_ARTIFACT_REASON,
  GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON,
  GPU_HMR_TEST_TIMING_V3_DERIVED_INTERVAL_REASON,
  GPU_HMR_TEST_TIMING_V3_EXTERNAL_PERSISTENCE_REASON,
  GPU_HMR_TEST_TIMING_V3_MAX_ATTEMPTS_PER_PHASE,
  GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS,
  GPU_HMR_TEST_TIMING_V3_MAX_NS_DIGITS,
  GPU_HMR_TEST_TIMING_V3_MAX_RECORD_BYTES,
  GPU_HMR_TEST_TIMING_V3_PHASES,
  GPU_HMR_TEST_TIMING_V3_SCHEMA,
  assertValidGpuHmrTestTimingV3,
  beginGpuHmrTestTimingV3SessionAttempt,
  bindGpuHmrTestTimingV3Session,
  captureGpuHmrTestTimingV3ClockReading,
  createGpuHmrTestTimingV3AbsentArtifactBinding,
  createGpuHmrTestTimingV3ClockCapability,
  createGpuHmrTestTimingV3ClockSourceManifest,
  createGpuHmrTestTimingV3PersistenceOperation,
  createGpuHmrTestTimingV3PersistenceReceipt,
  createGpuHmrTestTimingV3Recorder,
  createGpuHmrTestTimingV3Session,
  createGpuHmrTestTimingV3TestClockCapability,
  deriveGpuHmrTestTimingV3Summary,
  getGpuHmrTestTimingV3ClockSourceManifest,
  finishGpuHmrTestTimingV3SessionAttempt,
  markGpuHmrTestTimingV3SessionPhaseNotApplicable,
  markGpuHmrTestTimingV3SessionPhaseUnavailable,
  markGpuHmrTestTimingV3SessionPresentationComplete,
  prepareGpuHmrTestTimingV3Persistence,
  sealGpuHmrTestTimingV3Session,
  validateGpuHmrTestTimingV3,
  validateGpuHmrTestTimingV3ClockSourceManifest,
  validateGpuHmrTestTimingV3PersistenceReceipt,
} from '../lib/gpu-hmr-test-timing-v3.mjs';

function hash(character) {
  return `sha256:${character.repeat(64)}`;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function clockManifestInput(overrides = {}) {
  return {
    recorderImplementationHash: hash('a'),
    clockDomainId: 'clock-domain:test:1',
    clockSourceIdentityHash: hash('b'),
    runtimeSessionId: 'runtime-session:test:1',
    processIdentity: 'process:test:1',
    evidenceRefs: ['evidence:clock-source:1'],
    ...overrides,
  };
}

function binding(manifest, overrides = {}) {
  return {
    runMode: 'cold',
    splitMode: 'fresh_ai',
    modality: 'visual',
    outcome: 'completed',
    sourceManifestHash: hash('1'),
    editId: 'edit:test:1',
    editHash: hash('2'),
    artifactHash: hash('3'),
    proofLedgerId: `proof-ledger:${hash('4')}`,
    runtimeProofId: `runtime-proof:${hash('5')}`,
    runtimeSessionId: manifest.runtimeSessionId,
    processIdentity: manifest.processIdentity,
    clockSourceManifestId: manifest.manifestId,
    clockSourceIdentityHash: manifest.clockSourceIdentityHash,
    clockDomainId: manifest.clockDomainId,
    ...overrides,
  };
}

function deferredBinding(manifest, overrides = {}) {
  const value = binding(manifest, overrides);
  delete value.outcome;
  delete value.artifactHash;
  delete value.proofLedgerId;
  delete value.runtimeProofId;
  return value;
}

function sessionBindingMetadata(overrides = {}) {
  return {
    runMode: 'cold',
    splitMode: 'fresh_ai',
    modality: 'visual',
    sourceManifestHash: hash('1'),
    editId: 'edit:test:1',
    editHash: hash('2'),
    ...overrides,
  };
}

function terminalBinding(overrides = {}) {
  return {
    outcome: 'completed',
    artifactHash: hash('3'),
    proofLedgerId: `proof-ledger:${hash('4')}`,
    runtimeProofId: `runtime-proof:${hash('5')}`,
    ...overrides,
  };
}

function completedDeferredBinding(runBinding, terminal) {
  return {
    ...structuredClone(runBinding),
    ...structuredClone(terminal),
  };
}

function controlledClock(initialNs = 1_000_000n) {
  let current = initialNs;
  return {
    now: () => current,
    tick: (amount = 10n) => {
      current += amount;
      return current;
    },
  };
}

function sequentialClock(initialNs = 10_000n) {
  let current = initialNs;
  return {
    now: () => {
      const observed = current;
      current += 1n;
      return observed;
    },
    tick: () => current,
  };
}

function waitClock() {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  return {
    tick: () => Atomics.wait(waitBuffer, 0, 0, 1),
  };
}

function testClockFixture(clock = controlledClock(), overrides = {}) {
  const capability = createGpuHmrTestTimingV3TestClockCapability({
    now: clock.now,
    manifestInput: clockManifestInput(overrides),
  });
  return {
    capability,
    clock,
    manifest: getGpuHmrTestTimingV3ClockSourceManifest(capability),
  };
}

function productionClockFixture(overrides = {}) {
  const capability = createGpuHmrTestTimingV3ClockCapability(
    clockManifestInput(overrides),
  );
  return {
    capability,
    clock: waitClock(),
    manifest: getGpuHmrTestTimingV3ClockSourceManifest(capability),
  };
}

function attempt(recorder, clock, phaseKey, duration = 10n, result = 'completed', suffix = '1') {
  const token = recorder.beginAttempt(phaseKey, {
    source: `source:${phaseKey}`,
    evidenceRefs: [`evidence:${phaseKey}:${suffix}:start`],
  });
  clock.tick(duration);
  return recorder.finishAttempt(token, {
    result,
    evidenceRefs: [`evidence:${phaseKey}:${suffix}:end`],
  });
}

function sessionRecorder(sessionCapability) {
  return {
    beginAttempt: (phaseKey, options) => beginGpuHmrTestTimingV3SessionAttempt(
      sessionCapability,
      phaseKey,
      options,
    ),
    finishAttempt: (attemptCapability, options) => finishGpuHmrTestTimingV3SessionAttempt(
      sessionCapability,
      attemptCapability,
      options,
    ),
    markNotApplicable: (phaseKey, reasonCode, evidenceRefs) => (
      markGpuHmrTestTimingV3SessionPhaseNotApplicable(
        sessionCapability,
        phaseKey,
        reasonCode,
        evidenceRefs,
      )
    ),
    markUnavailable: (phaseKey, reasonCode, evidenceRefs) => (
      markGpuHmrTestTimingV3SessionPhaseUnavailable(
        sessionCapability,
        phaseKey,
        reasonCode,
        evidenceRefs,
      )
    ),
    markPresentationComplete: (options) => (
      markGpuHmrTestTimingV3SessionPresentationComplete(sessionCapability, options)
    ),
  };
}

function completeRecord({
  modality,
  clockFixture,
  bindingValue,
  compileRetry = false,
  dispatchFailureEvidenceRefs = null,
  outputRetry = false,
  captureRetry = false,
}) {
  const { capability, clock } = clockFixture;
  const recorder = createGpuHmrTestTimingV3Recorder({
    clockCapability: capability,
    binding: bindingValue,
    totalSource: 'source:validator',
    totalEvidenceRefs: ['evidence:validator:total'],
  });

  attempt(recorder, clock, 'discovery', 11n);
  attempt(recorder, clock, 'provider_availability', 13n);
  attempt(recorder, clock, 'ai_split', 17n);
  if (compileRetry) attempt(recorder, clock, 'compile', 19n, 'failed', '1');
  attempt(recorder, clock, 'compile', 23n, 'completed', compileRetry ? '2' : '1');
  attempt(recorder, clock, 'artifact_load', 29n);
  attempt(recorder, clock, 'epoch_publish', 31n);
  if (dispatchFailureEvidenceRefs !== null) {
    const dispatchFailureToken = recorder.beginAttempt('dispatch', {
      source: 'source:dispatch',
      evidenceRefs: dispatchFailureEvidenceRefs,
    });
    clock.tick(35n);
    recorder.finishAttempt(dispatchFailureToken, {
      result: 'failed',
      evidenceRefs: [],
    });
  }
  attempt(
    recorder,
    clock,
    'dispatch',
    37n,
    'completed',
    dispatchFailureEvidenceRefs === null ? '1' : '2',
  );
  if (outputRetry) attempt(recorder, clock, 'output_ready', 41n, 'failed', '1');
  const output = attempt(
    recorder,
    clock,
    'output_ready',
    43n,
    'completed',
    outputRetry ? '2' : '1',
  );

  if (modality === 'visual') {
    clock.tick(5n);
    recorder.markPresentationComplete({
      source: 'source:presentation-complete',
      evidenceRefs: ['evidence:presentation-complete'],
    });
    clock.tick(7n);
    if (captureRetry) attempt(recorder, clock, 'visual_capture', 47n, 'failed', '1');
    attempt(
      recorder,
      clock,
      'visual_capture',
      53n,
      'completed',
      captureRetry ? '2' : '1',
    );
    attempt(recorder, clock, 'visual_analysis', 59n);
  } else {
    for (const phaseKey of ['visual_capture', 'visual_analysis']) {
      recorder.markNotApplicable(
        phaseKey,
        GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON,
        [`evidence:${phaseKey}:compute-modality`],
      );
    }
  }

  attempt(recorder, clock, 'oracle_analysis', 61n);
  attempt(recorder, clock, 'retirement', 67n);
  attempt(recorder, clock, 'proof_finalization', 71n);
  attempt(recorder, clock, 'cleanup', 79n);
  clock.tick(83n);
  return recorder.finalize();
}

function recordCompletedSessionPhases(recorder, clock, modality, {
  markPresentation = true,
  discoveryAlreadyRecorded = false,
} = {}) {
  if (!discoveryAlreadyRecorded) attempt(recorder, clock, 'discovery', 11n);
  attempt(recorder, clock, 'provider_availability', 13n);
  attempt(recorder, clock, 'ai_split', 17n);
  attempt(recorder, clock, 'compile', 19n);
  attempt(recorder, clock, 'artifact_load', 23n);
  attempt(recorder, clock, 'epoch_publish', 29n);
  attempt(recorder, clock, 'dispatch', 31n);
  attempt(recorder, clock, 'output_ready', 37n);
  if (modality === 'visual') {
    if (markPresentation) {
      clock.tick(5n);
      recorder.markPresentationComplete({
        source: 'source:session-presentation-complete',
        evidenceRefs: ['evidence:session-presentation-complete'],
      });
    }
    clock.tick(7n);
    attempt(recorder, clock, 'visual_capture', 41n);
    attempt(recorder, clock, 'visual_analysis', 43n);
  } else {
    for (const phaseKey of ['visual_capture', 'visual_analysis']) {
      recorder.markNotApplicable(
        phaseKey,
        GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON,
        [`evidence:session:${phaseKey}:compute-modality`],
      );
    }
  }
  attempt(recorder, clock, 'oracle_analysis', 47n);
  attempt(recorder, clock, 'retirement', 53n);
  attempt(recorder, clock, 'proof_finalization', 59n);
  attempt(recorder, clock, 'cleanup', 61n);
  clock.tick(67n);
}

function sealPreArtifactSession({
  clockFixture,
  runBinding,
  outcome,
  compileFailures = 0,
}) {
  const capabilities = createGpuHmrTestTimingV3Session({
    clockCapability: clockFixture.capability,
    binding: runBinding,
    totalSource: `source:session:${outcome}:validator`,
    totalEvidenceRefs: [`evidence:session:${outcome}:total`],
  });
  const recorder = sessionRecorder(capabilities.sessionCapability);
  attempt(recorder, clockFixture.clock, 'discovery', 11n);
  for (const phaseKey of ['provider_availability', 'ai_split']) {
    recorder.markUnavailable(
      phaseKey,
      'required_boundary_not_observed',
      [`evidence:session:${outcome}:${phaseKey}`],
    );
  }
  if (compileFailures === 0) {
    recorder.markUnavailable(
      'compile',
      'required_boundary_not_observed',
      [`evidence:session:${outcome}:compile`],
    );
  } else {
    for (let index = 1; index <= compileFailures; index += 1) {
      attempt(
        recorder,
        clockFixture.clock,
        'compile',
        BigInt(12 + index),
        'failed',
        String(index),
      );
    }
  }
  for (const phaseKey of [
    'artifact_load',
    'epoch_publish',
    'dispatch',
    'output_ready',
    'oracle_analysis',
    'retirement',
  ]) {
    recorder.markUnavailable(
      phaseKey,
      'required_boundary_not_observed',
      [`evidence:session:${outcome}:${phaseKey}`],
    );
  }
  for (const phaseKey of ['visual_capture', 'visual_analysis']) {
    recorder.markNotApplicable(
      phaseKey,
      GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON,
      [`evidence:session:${outcome}:${phaseKey}`],
    );
  }
  attempt(
    recorder,
    clockFixture.clock,
    'proof_finalization',
    17n,
    outcome === 'failed' ? 'failed' : 'completed',
  );
  attempt(recorder, clockFixture.clock, 'cleanup', 19n);
  clockFixture.clock.tick(23n);
  const terminal = terminalBinding({
    outcome,
    artifactHash: createGpuHmrTestTimingV3AbsentArtifactBinding(),
    proofLedgerId: null,
    runtimeProofId: null,
  });
  return {
    record: sealGpuHmrTestTimingV3Session(capabilities.sealCapability, terminal),
    terminal,
  };
}

function phase(record, phaseKey) {
  return record.phases.find((entry) => entry.phase === phaseKey);
}

function validationOptions(bindingValue, manifest) {
  return {
    expectedBinding: bindingValue,
    trustedClockSourceManifest: manifest,
  };
}

function capturePersistenceReadings(persistenceOperation, clock) {
  const writeStartReading = captureGpuHmrTestTimingV3ClockReading(
    persistenceOperation,
    'write_start',
  );
  clock.tick();
  const writeEndReading = captureGpuHmrTestTimingV3ClockReading(
    persistenceOperation,
    'write_end',
  );
  clock.tick();
  const verifiedAtReading = captureGpuHmrTestTimingV3ClockReading(
    persistenceOperation,
    'read_verify',
  );
  return { writeStartReading, writeEndReading, verifiedAtReading };
}

function persistenceReceiptInput(
  persistenceOperation,
  operationInput,
  readings,
  overrides = {},
) {
  const effectiveInput = { ...operationInput, ...overrides };
  return {
    persistenceOperation,
    ...effectiveInput,
    writeStartReading: readings.writeStartReading,
    writeEndReading: readings.writeEndReading,
    writeSource: 'source:persistence-writer',
    writeEvidenceRefs: ['evidence:persistence:write'],
    readableAfterWrite: {
      verified: true,
      verifiedAtReading: readings.verifiedAtReading,
      readerIdentity: 'reader:test:1',
      observedByteLength: effectiveInput.persistencePlan.byteLength,
      observedByteHash: effectiveInput.persistencePlan.byteHash,
      evidenceRefs: ['evidence:persistence:read'],
    },
  };
}

function assertRejected(record, options, expectedGap) {
  const validation = validateGpuHmrTestTimingV3(record, options);
  assert.equal(validation.valid, false, `forgery unexpectedly passed: ${expectedGap}`);
  assert.ok(
    validation.gaps.some((gap) => gap.includes(expectedGap)),
    `missing ${expectedGap}; got ${validation.gaps.join(', ')}`,
  );
  assert.equal(validation.recomputedSummary, null);
  const derived = deriveGpuHmrTestTimingV3Summary(record, options);
  assert.equal(derived.valid, false);
  assert.equal(derived.summary, null);
  assert.equal(derived.error.code, 'timing_v3_record_invalid');
}

const visualClockFixture = testClockFixture();
const visualManifest = visualClockFixture.manifest;
const visualBinding = binding(visualManifest);
const visualOptions = validationOptions(visualBinding, visualManifest);
const visual = completeRecord({
  modality: 'visual',
  clockFixture: visualClockFixture,
  bindingValue: visualBinding,
  compileRetry: true,
  outputRetry: true,
  captureRetry: true,
});
const visualValidation = validateGpuHmrTestTimingV3(visual, visualOptions);
assert.equal(visualValidation.valid, true, visualValidation.gaps.join(', '));
assert.equal(visual.schema, GPU_HMR_TEST_TIMING_V3_SCHEMA);
assert.equal(visual.clock.kind, 'monotonic_ns');
assert.equal(visual.clock.unit, 'nanosecond');
assert.equal(visual.clock.sourceManifestId, visualManifest.manifestId);
assert.equal(visual.authority, 'timing_measurement_only_not_gpu_hmr_acceptance');
assert.equal(visual.acceptedForGpuHmr, false);
assert.equal(visual.gpuHmrSuccess, false);
assert.equal(phase(visual, 'compile').attempts.length, 2);
assert.equal(phase(visual, 'compile').attempts[0].result, 'failed');
assert.equal(phase(visual, 'compile').attempts[1].result, 'completed');
assert.equal(visual.summary.phaseAttemptCount.visual_capture, 2);
assert.equal(visual.summary.phaseFailedAttemptCount.visual_capture, 1);
assert.equal(visual.firstOutputReadyBoundary, null);
assert.ok(
  BigInt(visual.firstVisibleBoundary.monotonicNs)
    > BigInt(phase(visual, 'output_ready').attempts[1].endNs),
);
assert.ok(
  BigInt(visual.firstVisibleBoundary.monotonicNs)
    < BigInt(phase(visual, 'visual_capture').attempts[0].startNs),
);
assert.equal(visual.firstVisibleBoundary.kind, 'post_dispatch_presentation_complete');
assert.deepEqual(
  visual.firstVisibleBoundary.evidenceRefs,
  ['evidence:presentation-complete'],
);
assert.equal(visual.firstVisibleBoundary.source, 'source:presentation-complete');
const visualTotalStartNs = BigInt(phase(visual, 'total_validator_wall').attempts[0].startNs);
assert.equal(
  visual.summary.timeToFirstVisibleNs,
  (BigInt(visual.firstVisibleBoundary.monotonicNs) - visualTotalStartNs).toString(),
);
assert.ok(
  BigInt(visual.summary.timeToFirstVisibleNs)
    < BigInt(phase(visual, 'visual_capture').attempts.at(-1).endNs) - visualTotalStartNs,
);
const visualDispatch = phase(visual, 'dispatch').attempts[0];
const visualOracle = phase(visual, 'oracle_analysis').attempts[0];
const visualDispatchProof = phase(visual, 'dispatch_to_output_proof');
assert.equal(visualDispatchProof.measurementKind, 'derived');
assert.equal(visualDispatchProof.attempts.length, 1);
assert.equal(visualDispatchProof.attempts[0].startNs, visualDispatch.endNs);
assert.equal(visualDispatchProof.attempts[0].endNs, visualOracle.endNs);
assert.equal(
  visual.summary.dispatchToOutputProofNs,
  (BigInt(visualOracle.endNs) - BigInt(visualDispatch.endNs)).toString(),
);
const visualPersistencePhase = phase(visual, 'durable_persistence');
assert.equal(visualPersistencePhase.disposition, 'not_applicable');
assert.equal(visualPersistencePhase.reasonCode, GPU_HMR_TEST_TIMING_V3_EXTERNAL_PERSISTENCE_REASON);
assert.deepEqual(visualPersistencePhase.attempts, []);
assert.equal(visual.summary.phaseDurationNs.durable_persistence, null);
const visualSummary = deriveGpuHmrTestTimingV3Summary(visual, visualOptions);
assert.equal(visualSummary.valid, true);
assert.deepEqual(visualSummary.summary, visual.summary);
assert.equal(visualSummary.error, null);
assert.equal(assertValidGpuHmrTestTimingV3(visual, visualOptions), visual);
assert.ok(Object.isFrozen(visual));
assert.ok(Object.isFrozen(visual.binding));
assert.ok(Object.isFrozen(visualClockFixture.capability));
assert.deepEqual(Object.keys(visualClockFixture.capability), []);
assert.equal(visualManifest.clockImplementation, 'synthetic_test_clock');
assert.equal(visualManifest.testOnly, true);
assert.equal(visualManifest.persistenceEligible, false);
assert.throws(
  () => getGpuHmrTestTimingV3ClockSourceManifest(Object.freeze({})),
  /timing_v3_clock_capability_invalid/,
);
assert.throws(
  () => createGpuHmrTestTimingV3Recorder({
    clockCapability: Object.freeze({}),
    binding: visualBinding,
    totalSource: 'source:validator',
    totalEvidenceRefs: ['evidence:validator:total'],
  }),
  /timing_v3_recorder_options_invalid/,
);

const computeClockFixture = testClockFixture(controlledClock(), {
  clockDomainId: 'clock-domain:test:2',
  clockSourceIdentityHash: hash('c'),
  runtimeSessionId: 'runtime-session:test:2',
  processIdentity: 'process:test:2',
  evidenceRefs: ['evidence:clock-source:2'],
});
const computeManifest = computeClockFixture.manifest;
const computeBinding = binding(computeManifest, {
  runMode: 'hot_delta',
  splitMode: 'reused_ai',
  modality: 'compute',
  editId: 'edit:test:2',
  editHash: hash('6'),
  artifactHash: hash('7'),
  proofLedgerId: `proof-ledger:${hash('8')}`,
  runtimeProofId: `runtime-proof:${hash('9')}`,
});
const computeOptions = validationOptions(computeBinding, computeManifest);
const compute = completeRecord({
  modality: 'compute',
  clockFixture: computeClockFixture,
  bindingValue: computeBinding,
  outputRetry: true,
});
const computeValidation = validateGpuHmrTestTimingV3(compute, computeOptions);
assert.equal(computeValidation.valid, true, computeValidation.gaps.join(', '));
assert.equal(compute.firstVisibleBoundary, null);
assert.equal(compute.firstOutputReadyBoundary.kind, 'post_dispatch_output_ready');
assert.equal(
  compute.firstOutputReadyBoundary.monotonicNs,
  phase(compute, 'output_ready').attempts[1].endNs,
);
assert.equal(compute.summary.firstVisibleNs, null);
assert.equal(compute.summary.timeToFirstVisibleNs, null);
assert.ok(BigInt(compute.summary.timeToFirstOutputReadyNs) > 0n);
for (const phaseKey of ['visual_capture', 'visual_analysis']) {
  const value = phase(compute, phaseKey);
  assert.equal(value.disposition, 'not_applicable');
  assert.equal(value.reasonCode, GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON);
  assert.equal(compute.summary.phaseDurationNs[phaseKey], null);
}

const refusalClock = controlledClock(3_000_000n);
const refusalClockFixture = testClockFixture(refusalClock, {
  clockDomainId: 'clock-domain:test:refusal',
  clockSourceIdentityHash: hash('d'),
  runtimeSessionId: 'runtime-session:test:refusal',
  processIdentity: 'process:test:refusal',
  evidenceRefs: ['evidence:clock-source:refusal'],
});
const refusalManifest = refusalClockFixture.manifest;
const refusalBinding = binding(refusalManifest, {
  runMode: 'refusal',
  splitMode: 'not_applicable',
  modality: 'compute',
  outcome: 'refused',
  editId: 'edit:test:refusal',
  editHash: hash('a'),
  artifactHash: hash('b'),
  proofLedgerId: null,
  runtimeProofId: null,
});
const refusalRecorder = createGpuHmrTestTimingV3Recorder({
  clockCapability: refusalClockFixture.capability,
  binding: refusalBinding,
  totalSource: 'source:validator',
  totalEvidenceRefs: ['evidence:refusal:total'],
});
attempt(refusalRecorder, refusalClock, 'discovery', 11n);
for (const phaseKey of [
  'provider_availability',
  'ai_split',
  'compile',
  'artifact_load',
  'epoch_publish',
  'dispatch',
  'output_ready',
  'oracle_analysis',
  'retirement',
]) {
  refusalRecorder.markUnavailable(
    phaseKey,
    'required_boundary_not_observed',
    [`evidence:refusal:${phaseKey}`],
  );
}
for (const phaseKey of ['visual_capture', 'visual_analysis']) {
  refusalRecorder.markNotApplicable(
    phaseKey,
    GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON,
    [`evidence:refusal:${phaseKey}`],
  );
}
attempt(refusalRecorder, refusalClock, 'proof_finalization', 13n);
attempt(refusalRecorder, refusalClock, 'cleanup', 17n);
refusalClock.tick(19n);
const refusal = refusalRecorder.finalize();
const refusalOptions = validationOptions(refusalBinding, refusalManifest);
const refusalValidation = validateGpuHmrTestTimingV3(refusal, refusalOptions);
assert.equal(refusalValidation.valid, true, refusalValidation.gaps.join(', '));
assert.equal(phase(refusal, 'dispatch_to_output_proof').disposition, 'unavailable');
assert.equal(
  phase(refusal, 'dispatch_to_output_proof').reasonCode,
  GPU_HMR_TEST_TIMING_V3_DERIVED_INTERVAL_REASON,
);
assert.equal(refusal.firstOutputReadyBoundary, null);

const failedClock = controlledClock(4_000_000n);
const failedClockFixture = testClockFixture(failedClock, {
  clockDomainId: 'clock-domain:test:failed',
  clockSourceIdentityHash: hash('e'),
  runtimeSessionId: 'runtime-session:test:failed',
  processIdentity: 'process:test:failed',
  evidenceRefs: ['evidence:clock-source:failed'],
});
const failedBinding = binding(failedClockFixture.manifest, {
  runMode: 'warm',
  splitMode: 'reused_ai',
  modality: 'compute',
  outcome: 'failed',
  editId: 'edit:test:failed',
  editHash: hash('f'),
  artifactHash: hash('0'),
  proofLedgerId: null,
  runtimeProofId: null,
});
const failedRecorder = createGpuHmrTestTimingV3Recorder({
  clockCapability: failedClockFixture.capability,
  binding: failedBinding,
  totalSource: 'source:validator',
  totalEvidenceRefs: ['evidence:failed:total'],
});
attempt(failedRecorder, failedClock, 'discovery', 11n);
for (const phaseKey of ['provider_availability', 'ai_split']) {
  failedRecorder.markUnavailable(
    phaseKey,
    'required_boundary_not_observed',
    [`evidence:failed:${phaseKey}`],
  );
}
attempt(failedRecorder, failedClock, 'compile', 17n, 'failed', '1');
attempt(failedRecorder, failedClock, 'compile', 19n, 'failed', '2');
for (const phaseKey of [
  'artifact_load',
  'epoch_publish',
  'dispatch',
  'output_ready',
  'oracle_analysis',
  'retirement',
]) {
  failedRecorder.markUnavailable(
    phaseKey,
    'required_boundary_not_observed',
    [`evidence:failed:${phaseKey}`],
  );
}
for (const phaseKey of ['visual_capture', 'visual_analysis']) {
  failedRecorder.markNotApplicable(
    phaseKey,
    GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON,
    [`evidence:failed:${phaseKey}`],
  );
}
attempt(failedRecorder, failedClock, 'proof_finalization', 23n, 'failed');
attempt(failedRecorder, failedClock, 'cleanup', 29n);
failedClock.tick(31n);
const failedRecord = failedRecorder.finalize();
const failedOptions = validationOptions(failedBinding, failedClockFixture.manifest);
const failedValidation = validateGpuHmrTestTimingV3(failedRecord, failedOptions);
assert.equal(failedValidation.valid, true, failedValidation.gaps.join(', '));
assert.deepEqual(
  phase(failedRecord, 'compile').attempts.map((entry) => entry.result),
  ['failed', 'failed'],
);
assert.equal(failedRecord.summary.phaseAttemptCount.compile, 2);
assert.equal(failedRecord.summary.phaseFailedAttemptCount.compile, 2);
assert.equal(failedRecord.summary.phaseDurationNs.compile, '36');
assert.equal(phase(failedRecord, 'proof_finalization').attempts[0].result, 'failed');
assert.equal(failedRecord.summary.phaseFailedAttemptCount.proof_finalization, 1);

const liveClockFixture = testClockFixture(controlledClock(5_000_000n), {
  clockDomainId: 'clock-domain:test:live-session',
  clockSourceIdentityHash: hash('1'),
  runtimeSessionId: 'runtime-session:test:live-session',
  processIdentity: 'process:test:live-session',
  evidenceRefs: ['evidence:clock-source:live-session'],
});
const liveRunBinding = deferredBinding(liveClockFixture.manifest, {
  runMode: 'cold',
  splitMode: 'fresh_ai',
  modality: 'compute',
  editId: 'edit:test:live-session',
  editHash: hash('2'),
});
const trustedLiveRunBinding = structuredClone(liveRunBinding);
assert.throws(
  () => createGpuHmrTestTimingV3Session({
    clockCapability: liveClockFixture.capability,
    binding: binding(liveClockFixture.manifest, {
      modality: 'compute',
      editId: 'edit:test:eager-terminal-binding',
    }),
    totalSource: 'source:eager-terminal-binding:validator',
    totalEvidenceRefs: ['evidence:eager-terminal-binding:total'],
  }),
  (error) => error.code === 'timing_v3_session_options_invalid'
    && error.details.gaps.includes('binding_field_unexpected:outcome')
    && error.details.gaps.includes('binding_field_unexpected:artifactHash')
    && error.details.gaps.includes('binding_field_unexpected:proofLedgerId')
    && error.details.gaps.includes('binding_field_unexpected:runtimeProofId'),
);
const liveCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: liveClockFixture.capability,
  binding: liveRunBinding,
  totalSource: 'source:live-session:validator',
  totalEvidenceRefs: ['evidence:live-session:total'],
});
assert.deepEqual(Object.keys(liveCapabilities.sessionCapability), []);
assert.deepEqual(Object.keys(liveCapabilities.sealCapability), []);
assert.equal(Object.getPrototypeOf(liveCapabilities.sessionCapability), null);
assert.equal(Object.getPrototypeOf(liveCapabilities.sealCapability), null);
assert.ok(Object.isFrozen(liveCapabilities.sessionCapability));
assert.ok(Object.isFrozen(liveCapabilities.sealCapability));
assert.throws(
  () => beginGpuHmrTestTimingV3SessionAttempt(
    structuredClone(liveCapabilities.sessionCapability),
    'discovery',
    { source: 'source:cloned-session', evidenceRefs: ['evidence:cloned-session'] },
  ),
  /timing_v3_session_capability_invalid/,
);
assert.throws(
  () => sealGpuHmrTestTimingV3Session(
    structuredClone(liveCapabilities.sealCapability),
    terminalBinding(),
  ),
  /timing_v3_session_seal_capability_invalid/,
);
liveRunBinding.runMode = 'warm';
liveRunBinding.modality = 'visual';
liveRunBinding.editId = 'edit:test:relabel-attempt';
liveRunBinding.runtimeSessionId = 'runtime-session:test:relabel-attempt';
const liveRecorder = sessionRecorder(liveCapabilities.sessionCapability);
recordCompletedSessionPhases(liveRecorder, liveClockFixture.clock, 'compute');
const liveTerminal = terminalBinding({
  artifactHash: hash('3'),
  proofLedgerId: `proof-ledger:${hash('4')}`,
  runtimeProofId: `runtime-proof:${hash('5')}`,
});
const liveRecord = sealGpuHmrTestTimingV3Session(
  liveCapabilities.sealCapability,
  liveTerminal,
);
const liveExpectedBinding = completedDeferredBinding(
  trustedLiveRunBinding,
  liveTerminal,
);
const liveOptions = validationOptions(liveExpectedBinding, liveClockFixture.manifest);
const liveValidation = validateGpuHmrTestTimingV3(liveRecord, liveOptions);
assert.equal(liveValidation.valid, true, liveValidation.gaps.join(', '));
assert.equal(liveRecord.binding.runMode, 'cold');
assert.equal(liveRecord.binding.modality, 'compute');
assert.equal(liveRecord.binding.editId, 'edit:test:live-session');
assert.equal(
  liveRecord.binding.runtimeSessionId,
  liveClockFixture.manifest.runtimeSessionId,
);
assert.equal(liveRecord.firstVisibleBoundary, null);
assert.equal(
  liveRecord.firstOutputReadyBoundary.monotonicNs,
  phase(liveRecord, 'output_ready').attempts[0].endNs,
);
assert.equal(
  phase(liveRecord, 'durable_persistence').reasonCode,
  GPU_HMR_TEST_TIMING_V3_EXTERNAL_PERSISTENCE_REASON,
);
assert.equal(liveRecord.authority, 'timing_measurement_only_not_gpu_hmr_acceptance');
assert.equal(liveRecord.timingOnly, true);
assert.equal(liveRecord.acceptedForGpuHmr, false);
assert.equal(liveRecord.gpuHmrSuccess, false);
assert.throws(
  () => sealGpuHmrTestTimingV3Session(liveCapabilities.sealCapability, liveTerminal),
  /timing_v3_session_seal_consumed/,
);
assert.throws(
  () => liveRecorder.markUnavailable(
    'discovery',
    'replay_after_seal',
    ['evidence:replay-after-seal'],
  ),
  /timing_v3_session_consumed/,
);

const unboundSealClockFixture = testClockFixture(controlledClock(5_250_000n), {
  clockDomainId: 'clock-domain:test:unbound-seal',
  clockSourceIdentityHash: hash('6'),
  runtimeSessionId: 'runtime-session:test:unbound-seal',
  processIdentity: 'process:test:unbound-seal',
  evidenceRefs: ['evidence:clock-source:unbound-seal'],
});
const unboundSealCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: unboundSealClockFixture.capability,
  totalSource: 'source:unbound-seal:validator',
  totalEvidenceRefs: ['evidence:unbound-seal:total'],
});
assert.throws(
  () => sealGpuHmrTestTimingV3Session(
    unboundSealCapabilities.sealCapability,
    terminalBinding({ outcome: 'failed' }),
  ),
  /timing_v3_session_binding_required/,
);
assert.throws(
  () => bindGpuHmrTestTimingV3Session(
    unboundSealCapabilities.sessionCapability,
    sessionBindingMetadata({ modality: 'compute' }),
  ),
  /timing_v3_session_consumed/,
);

const lateBindingClockFixture = testClockFixture(controlledClock(5_300_000n), {
  clockDomainId: 'clock-domain:test:late-binding',
  clockSourceIdentityHash: hash('7'),
  runtimeSessionId: 'runtime-session:test:late-binding',
  processIdentity: 'process:test:late-binding',
  evidenceRefs: ['evidence:clock-source:late-binding'],
});
const lateBindingCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: lateBindingClockFixture.capability,
  totalSource: 'source:late-binding:validator',
  totalEvidenceRefs: ['evidence:late-binding:total'],
});
const lateBindingRecorder = sessionRecorder(lateBindingCapabilities.sessionCapability);
lateBindingClockFixture.clock.tick(3n);
const lateDiscoveryAttempt = lateBindingRecorder.beginAttempt('discovery', {
  source: 'source:late-binding:discovery',
  evidenceRefs: ['evidence:late-binding:discovery:start'],
});
lateBindingClockFixture.clock.tick(11n);
const lateDiscovery = lateBindingRecorder.finishAttempt(lateDiscoveryAttempt, {
  result: 'completed',
  evidenceRefs: ['evidence:late-binding:discovery:end'],
});
const lateMetadata = sessionBindingMetadata({
  runMode: 'cold',
  splitMode: 'fresh_ai',
  modality: 'compute',
  sourceManifestHash: hash('8'),
  editId: 'edit:test:late-binding',
  editHash: hash('9'),
});
const trustedLateMetadata = structuredClone(lateMetadata);
assert.throws(
  () => bindGpuHmrTestTimingV3Session(
    lateBindingCapabilities.sessionCapability,
    {
      ...lateMetadata,
      outputReadyNs: '1',
      presentationNs: '2',
      clockDomainId: 'clock-domain:remote',
    },
  ),
  (error) => error.code === 'timing_v3_session_binding_invalid'
    && error.details.gaps.includes('session_binding_field_unexpected:outputReadyNs')
    && error.details.gaps.includes('session_binding_field_unexpected:presentationNs')
    && error.details.gaps.includes('session_binding_field_unexpected:clockDomainId'),
);
recordCompletedSessionPhases(
  lateBindingRecorder,
  lateBindingClockFixture.clock,
  'compute',
  { discoveryAlreadyRecorded: true },
);
const boundLateBinding = bindGpuHmrTestTimingV3Session(
  lateBindingCapabilities.sessionCapability,
  lateMetadata,
);
assert.ok(Object.isFrozen(boundLateBinding));
assert.equal(boundLateBinding.runtimeSessionId, lateBindingClockFixture.manifest.runtimeSessionId);
assert.equal(boundLateBinding.processIdentity, lateBindingClockFixture.manifest.processIdentity);
assert.equal(boundLateBinding.clockSourceManifestId, lateBindingClockFixture.manifest.manifestId);
assert.equal(boundLateBinding.clockDomainId, lateBindingClockFixture.manifest.clockDomainId);
lateMetadata.runMode = 'warm';
lateMetadata.modality = 'visual';
lateMetadata.sourceManifestHash = hash('a');
lateMetadata.editId = 'edit:test:late-binding-mutated';
assert.throws(
  () => bindGpuHmrTestTimingV3Session(
    lateBindingCapabilities.sessionCapability,
    trustedLateMetadata,
  ),
  /timing_v3_session_binding_already_bound/,
);
assert.throws(
  () => bindGpuHmrTestTimingV3Session(
    lateBindingCapabilities.sessionCapability,
    {
      ...trustedLateMetadata,
      modality: 'visual',
      sourceManifestHash: hash('a'),
    },
  ),
  (error) => error.code === 'timing_v3_session_binding_conflict'
    && error.details.gaps.includes('session_binding_conflict:modality')
    && error.details.gaps.includes('session_binding_conflict:sourceManifestHash'),
);
const lateTerminal = terminalBinding({
  artifactHash: hash('b'),
  proofLedgerId: `proof-ledger:${hash('c')}`,
  runtimeProofId: `runtime-proof:${hash('d')}`,
});
const lateRecord = sealGpuHmrTestTimingV3Session(
  lateBindingCapabilities.sealCapability,
  lateTerminal,
);
const expectedLateRunBinding = deferredBinding(
  lateBindingClockFixture.manifest,
  trustedLateMetadata,
);
const expectedLateBinding = completedDeferredBinding(
  expectedLateRunBinding,
  lateTerminal,
);
const lateValidation = validateGpuHmrTestTimingV3(
  lateRecord,
  validationOptions(expectedLateBinding, lateBindingClockFixture.manifest),
);
assert.equal(lateValidation.valid, true, lateValidation.gaps.join(', '));
assert.equal(lateRecord.binding.runMode, trustedLateMetadata.runMode);
assert.equal(lateRecord.binding.modality, trustedLateMetadata.modality);
assert.equal(lateRecord.binding.sourceManifestHash, trustedLateMetadata.sourceManifestHash);
assert.equal(lateRecord.binding.editId, trustedLateMetadata.editId);
assert.equal(lateRecord.firstVisibleBoundary, null);
assert.equal(lateRecord.summary.firstVisibleNs, null);
assert.equal(
  lateRecord.firstOutputReadyBoundary.monotonicNs,
  phase(lateRecord, 'output_ready').attempts[0].endNs,
);
assert.notEqual(lateRecord.firstOutputReadyBoundary.monotonicNs, '1');
assert.equal(lateDiscovery.startNs, (5_300_000n + 3n).toString());
assert.equal(
  phase(lateRecord, 'total_validator_wall').attempts[0].startNs,
  '5300000',
);

const noLocalVisibleClockFixture = testClockFixture(controlledClock(5_400_000n), {
  clockDomainId: 'clock-domain:test:no-local-visible',
  clockSourceIdentityHash: hash('e'),
  runtimeSessionId: 'runtime-session:test:no-local-visible',
  processIdentity: 'process:test:no-local-visible',
  evidenceRefs: ['evidence:clock-source:no-local-visible'],
});
const noLocalVisibleCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: noLocalVisibleClockFixture.capability,
  totalSource: 'source:no-local-visible:validator',
  totalEvidenceRefs: ['evidence:no-local-visible:total'],
});
const noLocalVisibleRecorder = sessionRecorder(
  noLocalVisibleCapabilities.sessionCapability,
);
attempt(noLocalVisibleRecorder, noLocalVisibleClockFixture.clock, 'discovery', 5n);
const noLocalVisibleMetadata = sessionBindingMetadata({
  runMode: 'warm',
  splitMode: 'reused_ai',
  modality: 'visual',
  sourceManifestHash: hash('f'),
  editId: 'edit:test:no-local-visible',
  editHash: hash('0'),
});
assert.throws(
  () => bindGpuHmrTestTimingV3Session(
    noLocalVisibleCapabilities.sessionCapability,
    {
      ...noLocalVisibleMetadata,
      firstVisibleBoundary: {
        kind: 'post_dispatch_presentation_complete',
        monotonicNs: '1',
        clockDomainId: noLocalVisibleClockFixture.manifest.clockDomainId,
        source: 'source:remote-presentation',
        evidenceRefs: ['evidence:remote-presentation'],
      },
    },
  ),
  (error) => error.code === 'timing_v3_session_binding_invalid'
    && error.details.gaps.includes('session_binding_field_unexpected:firstVisibleBoundary'),
);
bindGpuHmrTestTimingV3Session(
  noLocalVisibleCapabilities.sessionCapability,
  noLocalVisibleMetadata,
);
for (const phaseKey of [
  'provider_availability',
  'ai_split',
  'compile',
  'artifact_load',
  'epoch_publish',
  'dispatch',
  'output_ready',
  'oracle_analysis',
  'visual_capture',
  'visual_analysis',
  'retirement',
]) {
  noLocalVisibleRecorder.markUnavailable(
    phaseKey,
    'required_boundary_not_observed',
    [`evidence:no-local-visible:${phaseKey}`],
  );
}
attempt(
  noLocalVisibleRecorder,
  noLocalVisibleClockFixture.clock,
  'proof_finalization',
  7n,
  'failed',
);
attempt(noLocalVisibleRecorder, noLocalVisibleClockFixture.clock, 'cleanup', 11n);
noLocalVisibleClockFixture.clock.tick(13n);
const noLocalVisibleTerminal = terminalBinding({
  outcome: 'failed',
  artifactHash: createGpuHmrTestTimingV3AbsentArtifactBinding(),
  proofLedgerId: null,
  runtimeProofId: null,
});
const noLocalVisibleRecord = sealGpuHmrTestTimingV3Session(
  noLocalVisibleCapabilities.sealCapability,
  noLocalVisibleTerminal,
);
const expectedNoLocalVisibleBinding = completedDeferredBinding(
  deferredBinding(noLocalVisibleClockFixture.manifest, noLocalVisibleMetadata),
  noLocalVisibleTerminal,
);
const noLocalVisibleValidation = validateGpuHmrTestTimingV3(
  noLocalVisibleRecord,
  validationOptions(
    expectedNoLocalVisibleBinding,
    noLocalVisibleClockFixture.manifest,
  ),
);
assert.equal(
  noLocalVisibleValidation.valid,
  true,
  noLocalVisibleValidation.gaps.join(', '),
);
assert.equal(noLocalVisibleRecord.firstVisibleBoundary, null);
assert.equal(noLocalVisibleRecord.firstOutputReadyBoundary, null);
assert.equal(noLocalVisibleRecord.summary.firstVisibleNs, null);
assert.equal(noLocalVisibleRecord.summary.timeToFirstVisibleNs, null);
assert.equal(noLocalVisibleRecord.summary.firstOutputReadyNs, null);
assert.equal(noLocalVisibleRecord.summary.timeToFirstOutputReadyNs, null);

const absentArtifact = createGpuHmrTestTimingV3AbsentArtifactBinding();
assert.deepEqual(absentArtifact, {
  kind: GPU_HMR_TEST_TIMING_V3_ABSENT_ARTIFACT_KIND,
  reasonCode: GPU_HMR_TEST_TIMING_V3_ABSENT_ARTIFACT_REASON,
});
assert.ok(Object.isFrozen(absentArtifact));
assert.throws(
  () => createGpuHmrTestTimingV3AbsentArtifactBinding('forged_reason'),
  /timing_v3_absent_artifact_options_forbidden/,
);

const liveRefusalClockFixture = testClockFixture(controlledClock(5_500_000n), {
  clockDomainId: 'clock-domain:test:live-refusal',
  clockSourceIdentityHash: hash('6'),
  runtimeSessionId: 'runtime-session:test:live-refusal',
  processIdentity: 'process:test:live-refusal',
  evidenceRefs: ['evidence:clock-source:live-refusal'],
});
const liveRefusalRunBinding = deferredBinding(liveRefusalClockFixture.manifest, {
  runMode: 'refusal',
  splitMode: 'not_applicable',
  modality: 'compute',
  editId: 'edit:test:live-refusal',
  editHash: hash('7'),
});
const liveRefusalResult = sealPreArtifactSession({
  clockFixture: liveRefusalClockFixture,
  runBinding: liveRefusalRunBinding,
  outcome: 'refused',
});
const liveRefusalOptions = validationOptions(
  completedDeferredBinding(liveRefusalRunBinding, liveRefusalResult.terminal),
  liveRefusalClockFixture.manifest,
);
const liveRefusalValidation = validateGpuHmrTestTimingV3(
  liveRefusalResult.record,
  liveRefusalOptions,
);
assert.equal(
  liveRefusalValidation.valid,
  true,
  liveRefusalValidation.gaps.join(', '),
);
assert.deepEqual(liveRefusalResult.record.binding.artifactHash, absentArtifact);
assert.equal(phase(liveRefusalResult.record, 'compile').disposition, 'unavailable');
assert.equal(phase(liveRefusalResult.record, 'artifact_load').attempts.length, 0);

const liveFailureClockFixture = testClockFixture(controlledClock(6_000_000n), {
  clockDomainId: 'clock-domain:test:live-failure',
  clockSourceIdentityHash: hash('8'),
  runtimeSessionId: 'runtime-session:test:live-failure',
  processIdentity: 'process:test:live-failure',
  evidenceRefs: ['evidence:clock-source:live-failure'],
});
const liveFailureRunBinding = deferredBinding(liveFailureClockFixture.manifest, {
  runMode: 'warm',
  splitMode: 'reused_ai',
  modality: 'compute',
  editId: 'edit:test:live-failure',
  editHash: hash('9'),
});
const liveFailureResult = sealPreArtifactSession({
  clockFixture: liveFailureClockFixture,
  runBinding: liveFailureRunBinding,
  outcome: 'failed',
  compileFailures: 2,
});
const liveFailureOptions = validationOptions(
  completedDeferredBinding(liveFailureRunBinding, liveFailureResult.terminal),
  liveFailureClockFixture.manifest,
);
const liveFailureValidation = validateGpuHmrTestTimingV3(
  liveFailureResult.record,
  liveFailureOptions,
);
assert.equal(
  liveFailureValidation.valid,
  true,
  liveFailureValidation.gaps.join(', '),
);
assert.deepEqual(
  phase(liveFailureResult.record, 'compile').attempts.map((entry) => entry.result),
  ['failed', 'failed'],
);
assert.deepEqual(liveFailureResult.record.binding.artifactHash, absentArtifact);

const timestampRunBinding = deferredBinding(liveFailureClockFixture.manifest, {
  runMode: 'warm',
  splitMode: 'reused_ai',
  modality: 'compute',
  editId: 'edit:test:timestamp-injection',
  editHash: hash('a'),
});
const timestampCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: liveFailureClockFixture.capability,
  binding: timestampRunBinding,
  totalSource: 'source:timestamp-injection:validator',
  totalEvidenceRefs: ['evidence:timestamp-injection:total'],
});
assert.throws(
  () => beginGpuHmrTestTimingV3SessionAttempt(
    timestampCapabilities.sessionCapability,
    'discovery',
    {
      source: 'source:timestamp-injection',
      evidenceRefs: ['evidence:timestamp-injection'],
      startNs: '1',
    },
  ),
  /timing_v3_attempt_begin_invalid/,
);
const timestampAttempt = beginGpuHmrTestTimingV3SessionAttempt(
  timestampCapabilities.sessionCapability,
  'discovery',
  {
    source: 'source:timestamp-intrinsic',
    evidenceRefs: ['evidence:timestamp-intrinsic:start'],
  },
);
assert.deepEqual(Object.keys(timestampAttempt), []);
assert.equal(Object.getPrototypeOf(timestampAttempt), null);
assert.ok(Object.isFrozen(timestampAttempt));
assert.throws(
  () => finishGpuHmrTestTimingV3SessionAttempt(
    timestampCapabilities.sessionCapability,
    structuredClone(timestampAttempt),
    { result: 'completed', evidenceRefs: [], endNs: '2' },
  ),
  /timing_v3_session_attempt_capability_invalid/,
);
assert.throws(
  () => finishGpuHmrTestTimingV3SessionAttempt(
    timestampCapabilities.sessionCapability,
    timestampAttempt,
    { result: 'completed', evidenceRefs: [], endNs: '2' },
  ),
  /timing_v3_attempt_finish_invalid/,
);
liveFailureClockFixture.clock.tick(7n);
const intrinsicAttempt = finishGpuHmrTestTimingV3SessionAttempt(
  timestampCapabilities.sessionCapability,
  timestampAttempt,
  { result: 'completed', evidenceRefs: ['evidence:timestamp-intrinsic:end'] },
);
assert.equal(intrinsicAttempt.durationNs, '7');
assert.notEqual(intrinsicAttempt.startNs, '1');
assert.notEqual(intrinsicAttempt.endNs, '2');
assert.throws(
  () => finishGpuHmrTestTimingV3SessionAttempt(
    timestampCapabilities.sessionCapability,
    timestampAttempt,
    { result: 'completed', evidenceRefs: [] },
  ),
  /timing_v3_session_attempt_consumed/,
);

const boundaryRunBinding = deferredBinding(liveFailureClockFixture.manifest, {
  runMode: 'warm',
  splitMode: 'reused_ai',
  modality: 'visual',
  editId: 'edit:test:boundary-injection',
  editHash: hash('b'),
});
const boundaryCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: liveFailureClockFixture.capability,
  binding: boundaryRunBinding,
  totalSource: 'source:boundary-injection:validator',
  totalEvidenceRefs: ['evidence:boundary-injection:total'],
});
const boundaryRecorder = sessionRecorder(boundaryCapabilities.sessionCapability);
attempt(boundaryRecorder, liveFailureClockFixture.clock, 'output_ready', 5n);
assert.throws(
  () => markGpuHmrTestTimingV3SessionPresentationComplete(
    boundaryCapabilities.sessionCapability,
    {
      source: 'source:boundary-injection',
      evidenceRefs: ['evidence:boundary-injection'],
      monotonicNs: '2',
    },
  ),
  /timing_v3_first_visible_invalid/,
);
liveFailureClockFixture.clock.tick(3n);
boundaryRecorder.markPresentationComplete({
  source: 'source:boundary-intrinsic',
  evidenceRefs: ['evidence:boundary-intrinsic'],
});

const crossSessionA = createGpuHmrTestTimingV3Session({
  clockCapability: liveFailureClockFixture.capability,
  binding: timestampRunBinding,
  totalSource: 'source:cross-session:a',
  totalEvidenceRefs: ['evidence:cross-session:a'],
});
const crossSessionB = createGpuHmrTestTimingV3Session({
  clockCapability: liveFailureClockFixture.capability,
  binding: timestampRunBinding,
  totalSource: 'source:cross-session:b',
  totalEvidenceRefs: ['evidence:cross-session:b'],
});
const crossAttemptA = beginGpuHmrTestTimingV3SessionAttempt(
  crossSessionA.sessionCapability,
  'discovery',
  { source: 'source:cross-session:a', evidenceRefs: ['evidence:cross-session:a'] },
);
const crossAttemptB = beginGpuHmrTestTimingV3SessionAttempt(
  crossSessionB.sessionCapability,
  'discovery',
  { source: 'source:cross-session:b', evidenceRefs: ['evidence:cross-session:b'] },
);
assert.throws(
  () => finishGpuHmrTestTimingV3SessionAttempt(
    crossSessionB.sessionCapability,
    crossAttemptA,
    { result: 'completed', evidenceRefs: [] },
  ),
  /timing_v3_session_attempt_mismatch/,
);
liveFailureClockFixture.clock.tick(5n);
finishGpuHmrTestTimingV3SessionAttempt(
  crossSessionA.sessionCapability,
  crossAttemptA,
  { result: 'completed', evidenceRefs: [] },
);
liveFailureClockFixture.clock.tick(5n);
finishGpuHmrTestTimingV3SessionAttempt(
  crossSessionB.sessionCapability,
  crossAttemptB,
  { result: 'completed', evidenceRefs: [] },
);

const missingTerminalCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: liveFailureClockFixture.capability,
  binding: timestampRunBinding,
  totalSource: 'source:missing-terminal:validator',
  totalEvidenceRefs: ['evidence:missing-terminal:total'],
});
assert.throws(
  () => sealGpuHmrTestTimingV3Session(missingTerminalCapabilities.sealCapability, {
    outcome: 'failed',
    artifactHash: createGpuHmrTestTimingV3AbsentArtifactBinding(),
    proofLedgerId: null,
  }),
  (error) => error.code === 'timing_v3_session_terminal_binding_invalid'
    && error.details.gaps.includes('terminal_binding_field_missing:runtimeProofId'),
);
assert.throws(
  () => sealGpuHmrTestTimingV3Session(
    missingTerminalCapabilities.sealCapability,
    terminalBinding({ outcome: 'failed' }),
  ),
  /timing_v3_session_seal_consumed/,
);
assert.throws(
  () => beginGpuHmrTestTimingV3SessionAttempt(
    missingTerminalCapabilities.sessionCapability,
    'discovery',
    { source: 'source:after-failed-seal', evidenceRefs: ['evidence:after-failed-seal'] },
  ),
  /timing_v3_session_consumed/,
);

const relabelCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: liveFailureClockFixture.capability,
  binding: timestampRunBinding,
  totalSource: 'source:seal-relabel:validator',
  totalEvidenceRefs: ['evidence:seal-relabel:total'],
});
assert.throws(
  () => sealGpuHmrTestTimingV3Session(relabelCapabilities.sealCapability, {
    ...terminalBinding({ outcome: 'failed' }),
    runMode: 'refusal',
  }),
  (error) => error.code === 'timing_v3_session_terminal_binding_invalid'
    && error.details.gaps.includes('terminal_binding_field_unexpected:runMode'),
);

const completedAbsenceCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: liveFailureClockFixture.capability,
  binding: timestampRunBinding,
  totalSource: 'source:completed-absence:validator',
  totalEvidenceRefs: ['evidence:completed-absence:total'],
});
assert.throws(
  () => sealGpuHmrTestTimingV3Session(
    completedAbsenceCapabilities.sealCapability,
    terminalBinding({ artifactHash: createGpuHmrTestTimingV3AbsentArtifactBinding() }),
  ),
  (error) => error.code === 'timing_v3_session_terminal_binding_invalid'
    && error.details.gaps.includes('terminal_binding_completed_artifact_hash_required'),
);
const forgedCompletedAbsence = structuredClone(liveRecord);
forgedCompletedAbsence.binding.artifactHash = createGpuHmrTestTimingV3AbsentArtifactBinding();
const forgedCompletedAbsenceBinding = structuredClone(liveExpectedBinding);
forgedCompletedAbsenceBinding.artifactHash = createGpuHmrTestTimingV3AbsentArtifactBinding();
assertRejected(
  forgedCompletedAbsence,
  validationOptions(forgedCompletedAbsenceBinding, liveClockFixture.manifest),
  'completed_artifact_absence_forbidden',
);
const forgedAbsenceAfterCompile = structuredClone(liveRecord);
forgedAbsenceAfterCompile.outcome = 'failed';
forgedAbsenceAfterCompile.binding.outcome = 'failed';
forgedAbsenceAfterCompile.binding.artifactHash = createGpuHmrTestTimingV3AbsentArtifactBinding();
forgedAbsenceAfterCompile.binding.proofLedgerId = null;
forgedAbsenceAfterCompile.binding.runtimeProofId = null;
assertRejected(
  forgedAbsenceAfterCompile,
  validationOptions(forgedAbsenceAfterCompile.binding, liveClockFixture.manifest),
  'absent_artifact_after_completed_compile',
);

const missingVisibleClockFixture = testClockFixture(controlledClock(6_500_000n), {
  clockDomainId: 'clock-domain:test:missing-visible',
  clockSourceIdentityHash: hash('b'),
  runtimeSessionId: 'runtime-session:test:missing-visible',
  processIdentity: 'process:test:missing-visible',
  evidenceRefs: ['evidence:clock-source:missing-visible'],
});
const missingVisibleRunBinding = deferredBinding(missingVisibleClockFixture.manifest, {
  runMode: 'cold',
  splitMode: 'fresh_ai',
  modality: 'visual',
  editId: 'edit:test:missing-visible',
  editHash: hash('c'),
});
const missingVisibleCapabilities = createGpuHmrTestTimingV3Session({
  clockCapability: missingVisibleClockFixture.capability,
  binding: missingVisibleRunBinding,
  totalSource: 'source:missing-visible:validator',
  totalEvidenceRefs: ['evidence:missing-visible:total'],
});
recordCompletedSessionPhases(
  sessionRecorder(missingVisibleCapabilities.sessionCapability),
  missingVisibleClockFixture.clock,
  'visual',
  { markPresentation: false },
);
assert.throws(
  () => sealGpuHmrTestTimingV3Session(
    missingVisibleCapabilities.sealCapability,
    terminalBinding({
      artifactHash: hash('d'),
      proofLedgerId: `proof-ledger:${hash('e')}`,
      runtimeProofId: `runtime-proof:${hash('f')}`,
    }),
  ),
  (error) => error.code === 'timing_v3_record_invalid'
    && error.details.gaps.includes('first_visible_boundary_required'),
);

assert.throws(
  () => prepareGpuHmrTestTimingV3Persistence(visual, visualOptions),
  /timing_v3_persistence_ineligible_clock/,
);

const persistedClockFixture = productionClockFixture({
  recorderImplementationHash: hash('e'),
  clockDomainId: 'clock-domain:persisted:1',
  clockSourceIdentityHash: hash('f'),
  runtimeSessionId: 'runtime-session:persisted:1',
  processIdentity: `process:pid:${process.pid}:persisted`,
  evidenceRefs: ['evidence:clock-source:persisted'],
});
const persistedBinding = binding(persistedClockFixture.manifest, {
  runMode: 'warm',
  splitMode: 'reused_ai',
  modality: 'compute',
  editId: 'edit:test:persisted',
  editHash: hash('6'),
  artifactHash: hash('7'),
});
assert.equal(persistedClockFixture.manifest.clockImplementation, 'node_process_hrtime_bigint');
assert.equal(persistedClockFixture.manifest.testOnly, false);
assert.equal(persistedClockFixture.manifest.persistenceEligible, true);
const persistedOptions = validationOptions(persistedBinding, persistedClockFixture.manifest);
const persistedRecord = completeRecord({
  modality: 'compute',
  clockFixture: persistedClockFixture,
  bindingValue: persistedBinding,
});
const persistencePlan = prepareGpuHmrTestTimingV3Persistence(
  persistedRecord,
  persistedOptions,
);
assert.equal(persistencePlan.timingRecordId, persistedRecord.recordId);
assert.equal(persistencePlan.timingRecordHash, persistencePlan.byteHash);
assert.equal(Buffer.byteLength(persistencePlan.serializedRecord), persistencePlan.byteLength);
assert.ok(Object.isFrozen(persistencePlan));
const writerClockFixture = productionClockFixture({
  recorderImplementationHash: hash('8'),
  clockDomainId: 'clock-domain:writer:1',
  clockSourceIdentityHash: hash('9'),
  runtimeSessionId: persistedBinding.runtimeSessionId,
  processIdentity: `process:pid:${process.pid}:writer:1`,
  evidenceRefs: ['evidence:clock-source:writer'],
});
const persistenceOperationInput = {
  persistencePlan,
  timingRecordValidationOptions: persistedOptions,
  writerClockCapability: writerClockFixture.capability,
  writerIdentity: 'writer:test:1',
  destinationIdentity: 'destination:test:1',
};
const persistenceOperation = createGpuHmrTestTimingV3PersistenceOperation(
  persistenceOperationInput,
);
assert.ok(Object.isFrozen(persistenceOperation));
assert.deepEqual(Object.keys(persistenceOperation), []);
assert.throws(
  () => captureGpuHmrTestTimingV3ClockReading(persistenceOperation, 'write_end'),
  /timing_v3_persistence_clock_reading_order_invalid/,
);
const writeStartReading = captureGpuHmrTestTimingV3ClockReading(
  persistenceOperation,
  'write_start',
);
writerClockFixture.clock.tick();
const writeEndReading = captureGpuHmrTestTimingV3ClockReading(
  persistenceOperation,
  'write_end',
);
writerClockFixture.clock.tick();
const verifiedAtReading = captureGpuHmrTestTimingV3ClockReading(
  persistenceOperation,
  'read_verify',
);
const receiptInput = {
  persistenceOperation,
  ...persistenceOperationInput,
  writeStartReading,
  writeEndReading,
  writeSource: 'source:persistence-writer',
  writeEvidenceRefs: ['evidence:persistence:write'],
  readableAfterWrite: {
    verified: true,
    verifiedAtReading,
    readerIdentity: 'reader:test:1',
    observedByteLength: persistencePlan.byteLength,
    observedByteHash: persistencePlan.byteHash,
    evidenceRefs: ['evidence:persistence:read'],
  },
};
const receipt = createGpuHmrTestTimingV3PersistenceReceipt(receiptInput);
const receiptOptions = {
  expectedPersistencePlan: persistencePlan,
  timingRecordValidationOptions: persistedOptions,
  trustedWriterClockCapability: writerClockFixture.capability,
  expectedWriterIdentity: 'writer:test:1',
  expectedDestinationIdentity: 'destination:test:1',
};
const receiptValidation = validateGpuHmrTestTimingV3PersistenceReceipt(
  receipt,
  receiptOptions,
);
assert.equal(receiptValidation.valid, true, receiptValidation.gaps.join(', '));
assert.equal(receipt.authority, 'persistence_receipt_only_not_gpu_hmr_acceptance');
assert.equal(receipt.acceptedForGpuHmr, false);
assert.equal(receipt.gpuHmrSuccess, false);
assert.throws(
  () => createGpuHmrTestTimingV3PersistenceReceipt(receiptInput),
  (error) => error.details.gaps.includes('persistence_operation_consumed')
    && error.details.gaps.some((gap) => gap.endsWith('_consumed')),
);

const intrinsicWriterClockFixture = productionClockFixture({
  recorderImplementationHash: hash('a'),
  clockDomainId: 'clock-domain:writer:intrinsic',
  clockSourceIdentityHash: hash('b'),
  runtimeSessionId: persistedBinding.runtimeSessionId,
  processIdentity: `process:pid:${process.pid}:writer:intrinsic`,
  evidenceRefs: ['evidence:clock-source:writer-intrinsic'],
});
const intrinsicPersistenceOperation = createGpuHmrTestTimingV3PersistenceOperation({
  ...persistenceOperationInput,
  writerClockCapability: intrinsicWriterClockFixture.capability,
  writerIdentity: 'writer:test:intrinsic',
});
const originalHrtimeBigint = process.hrtime.bigint;
let patchedHrtimeCalls = 0;
try {
  process.hrtime.bigint = () => {
    patchedHrtimeCalls += 1;
    return 1n;
  };
  captureGpuHmrTestTimingV3ClockReading(
    intrinsicPersistenceOperation,
    'write_start',
  );
} finally {
  process.hrtime.bigint = originalHrtimeBigint;
}
assert.equal(patchedHrtimeCalls, 0);

const replayClockFixture = productionClockFixture({
  recorderImplementationHash: hash('0'),
  clockDomainId: 'clock-domain:persisted:replay',
  clockSourceIdentityHash: hash('1'),
  runtimeSessionId: 'runtime-session:persisted:replay',
  processIdentity: `process:pid:${process.pid}:persisted:replay`,
  evidenceRefs: ['evidence:clock-source:persisted-replay'],
});
const replayBinding = binding(replayClockFixture.manifest, {
  runMode: 'hot_delta',
  splitMode: 'reused_ai',
  modality: 'compute',
  editId: 'edit:test:persisted-replay',
  editHash: hash('2'),
  artifactHash: hash('3'),
});
const replayOptions = validationOptions(replayBinding, replayClockFixture.manifest);
const replayRecord = completeRecord({
  modality: 'compute',
  clockFixture: replayClockFixture,
  bindingValue: replayBinding,
});
const computePersistencePlan = prepareGpuHmrTestTimingV3Persistence(
  replayRecord,
  replayOptions,
);
const receiptReplay = validateGpuHmrTestTimingV3PersistenceReceipt(receipt, {
  ...receiptOptions,
  expectedPersistencePlan: computePersistencePlan,
  timingRecordValidationOptions: replayOptions,
});
assert.equal(receiptReplay.valid, false);
assert.ok(receiptReplay.gaps.includes('persistence_receipt_replay:timingRecordId'));
assert.equal(
  validateGpuHmrTestTimingV3PersistenceReceipt(receipt, {
    ...receiptOptions,
    expectedDestinationIdentity: 'destination:test:other',
  }).valid,
  false,
);
const otherWriterClockFixture = productionClockFixture({
  recorderImplementationHash: hash('0'),
  clockDomainId: 'clock-domain:writer:other',
  clockSourceIdentityHash: hash('1'),
  runtimeSessionId: 'runtime-session:writer:other',
  processIdentity: `process:pid:${process.pid}:writer:other`,
  evidenceRefs: ['evidence:clock-source:writer-other'],
});
const writerManifestReplay = validateGpuHmrTestTimingV3PersistenceReceipt(receipt, {
  ...receiptOptions,
  trustedWriterClockCapability: otherWriterClockFixture.capability,
});
assert.equal(writerManifestReplay.valid, false);
assert.ok(writerManifestReplay.gaps.includes('persistence_receipt_process_identity_mismatch'));
assert.equal(
  validateGpuHmrTestTimingV3PersistenceReceipt(receipt, {
    ...receiptOptions,
    expectedWriterIdentity: 'writer:test:other',
  }).valid,
  false,
);

const recordReplayOperation = createGpuHmrTestTimingV3PersistenceOperation(
  persistenceOperationInput,
);
const recordReplayReadings = capturePersistenceReadings(
  recordReplayOperation,
  writerClockFixture.clock,
);
assert.throws(
  () => createGpuHmrTestTimingV3PersistenceReceipt(persistenceReceiptInput(
    recordReplayOperation,
    persistenceOperationInput,
    recordReplayReadings,
    {
      persistencePlan: computePersistencePlan,
      timingRecordValidationOptions: replayOptions,
    },
  )),
  (error) => error.details.gaps.includes('persistence_operation_plan_identity_mismatch')
    && error.details.gaps.includes('persistence_operation_plan_mismatch:timingRecordId'),
);

const destinationReplayOperation = createGpuHmrTestTimingV3PersistenceOperation(
  persistenceOperationInput,
);
const destinationReplayReadings = capturePersistenceReadings(
  destinationReplayOperation,
  writerClockFixture.clock,
);
assert.throws(
  () => createGpuHmrTestTimingV3PersistenceReceipt(persistenceReceiptInput(
    destinationReplayOperation,
    persistenceOperationInput,
    destinationReplayReadings,
    { destinationIdentity: 'destination:test:other' },
  )),
  (error) => error.details.gaps.includes('persistence_operation_destination_mismatch'),
);
assert.throws(
  () => createGpuHmrTestTimingV3PersistenceReceipt(persistenceReceiptInput(
    destinationReplayOperation,
    persistenceOperationInput,
    destinationReplayReadings,
  )),
  (error) => error.details.gaps.includes('persistence_operation_consumed')
    && error.details.gaps.some((gap) => gap.endsWith('_consumed')),
);

const duplicateTokenOperation = createGpuHmrTestTimingV3PersistenceOperation(
  persistenceOperationInput,
);
const duplicateTokenReadings = capturePersistenceReadings(
  duplicateTokenOperation,
  writerClockFixture.clock,
);
const duplicateTokenInput = persistenceReceiptInput(
  duplicateTokenOperation,
  persistenceOperationInput,
  duplicateTokenReadings,
);
duplicateTokenInput.writeEndReading = duplicateTokenInput.writeStartReading;
assert.throws(
  () => createGpuHmrTestTimingV3PersistenceReceipt(duplicateTokenInput),
  (error) => error.details.gaps.includes('persistence_clock_reading_duplicate_token')
    && error.details.gaps.includes('persistence_write_end_reading_stage_mismatch'),
);

const expectedTokenOperation = createGpuHmrTestTimingV3PersistenceOperation(
  persistenceOperationInput,
);
const expectedTokenReadings = capturePersistenceReadings(
  expectedTokenOperation,
  writerClockFixture.clock,
);
const otherTokenOperationInput = {
  ...persistenceOperationInput,
  writerClockCapability: otherWriterClockFixture.capability,
  writerIdentity: 'writer:test:other',
};
const otherTokenOperation = createGpuHmrTestTimingV3PersistenceOperation(
  otherTokenOperationInput,
);
const otherTokenReadings = capturePersistenceReadings(
  otherTokenOperation,
  otherWriterClockFixture.clock,
);
const crossOperationTokenInput = persistenceReceiptInput(
  expectedTokenOperation,
  persistenceOperationInput,
  expectedTokenReadings,
);
crossOperationTokenInput.writeEndReading = otherTokenReadings.writeEndReading;
assert.throws(
  () => createGpuHmrTestTimingV3PersistenceReceipt(crossOperationTokenInput),
  (error) => error.details.gaps.includes(
    'persistence_write_end_reading_operation_mismatch',
  ),
);

const unreadableReceipt = structuredClone(receipt);
unreadableReceipt.readableAfterWrite.verified = false;
const unreadableValidation = validateGpuHmrTestTimingV3PersistenceReceipt(
  unreadableReceipt,
  receiptOptions,
);
assert.equal(unreadableValidation.valid, false);
assert.ok(unreadableValidation.gaps.includes('persistence_receipt_read_not_verified'));
const wrongReadbackReceipt = structuredClone(receipt);
wrongReadbackReceipt.readableAfterWrite.observedByteHash = hash('0');
const wrongReadbackValidation = validateGpuHmrTestTimingV3PersistenceReceipt(
  wrongReadbackReceipt,
  receiptOptions,
);
assert.equal(wrongReadbackValidation.valid, false);
assert.ok(
  wrongReadbackValidation.gaps.includes('persistence_receipt_read_byte_hash_mismatch'),
);

const arbitraryRecordMaterial = '{"schema":"arbitrary.canonical.json"}';
const arbitraryRecordId = `gpu-hmr-test-timing-v3:${sha256(arbitraryRecordMaterial)}`;
const arbitrarySerializedRecord = `{"recordId":"${arbitraryRecordId}","schema":"arbitrary.canonical.json"}`;
const arbitraryByteHash = sha256(arbitrarySerializedRecord);
const arbitraryPersistencePlan = {
  schema: 'synthi.gpu_hmr.test_timing_persistence_plan.v1',
  timingRecordId: arbitraryRecordId,
  timingRecordHash: arbitraryByteHash,
  byteLength: Buffer.byteLength(arbitrarySerializedRecord),
  byteHash: arbitraryByteHash,
  serializedRecord: arbitrarySerializedRecord,
};
const arbitraryPlanReceiptValidation = validateGpuHmrTestTimingV3PersistenceReceipt(
  receipt,
  {
    ...receiptOptions,
    expectedPersistencePlan: arbitraryPersistencePlan,
  },
);
assert.equal(arbitraryPlanReceiptValidation.valid, false);
assert.ok(
  arbitraryPlanReceiptValidation.gaps.includes(
    'expected_persistence_plan_timing_record_invalid',
  ),
);
assert.throws(
  () => createGpuHmrTestTimingV3PersistenceOperation({
    persistencePlan: arbitraryPersistencePlan,
    timingRecordValidationOptions: persistedOptions,
    writerClockCapability: writerClockFixture.capability,
    writerIdentity: 'writer:test:1',
    destinationIdentity: 'destination:test:1',
  }),
  (error) => error.code === 'timing_v3_persistence_operation_input_invalid'
    && error.details.gaps.includes('persistence_operation_plan_timing_record_invalid'),
);
const wrongTimingTrust = validateGpuHmrTestTimingV3PersistenceReceipt(receipt, {
  ...receiptOptions,
  timingRecordValidationOptions: replayOptions,
});
assert.equal(wrongTimingTrust.valid, false);
assert.ok(wrongTimingTrust.gaps.includes('expected_persistence_plan_timing_record_invalid'));

const syntheticWriterClock = controlledClock(12_000_000n);
const syntheticWriterFixture = testClockFixture(syntheticWriterClock, {
  recorderImplementationHash: hash('4'),
  clockDomainId: 'clock-domain:writer:synthetic',
  clockSourceIdentityHash: hash('5'),
  runtimeSessionId: 'runtime-session:writer:synthetic',
  processIdentity: 'process:writer:synthetic',
  evidenceRefs: ['evidence:clock-source:writer-synthetic'],
});
assert.throws(
  () => createGpuHmrTestTimingV3PersistenceOperation({
    persistencePlan,
    timingRecordValidationOptions: persistedOptions,
    writerClockCapability: syntheticWriterFixture.capability,
    writerIdentity: 'writer:test:synthetic',
    destinationIdentity: 'destination:test:1',
  }),
  (error) => error.details.gaps.includes('writer_clock_not_persistence_eligible'),
);

for (const [field, replacement] of [
  ['runMode', 'warm'],
  ['splitMode', 'reused_ai'],
  ['modality', 'compute'],
  ['outcome', 'refused'],
  ['sourceManifestHash', hash('c')],
  ['editId', 'edit:test:replay'],
  ['editHash', hash('d')],
  ['artifactHash', hash('e')],
  ['proofLedgerId', `proof-ledger:${hash('f')}`],
  ['runtimeProofId', `runtime-proof:${hash('0')}`],
  ['runtimeSessionId', 'runtime-session:test:replay'],
  ['processIdentity', 'process:test:replay'],
  ['clockDomainId', 'clock-domain:test:replay'],
]) {
  assertRejected(
    structuredClone(visual),
    validationOptions({ ...visualBinding, [field]: replacement }, visualManifest),
    `binding_replay_mismatch:${field}`,
  );
}

const modalityReplay = structuredClone(visual);
modalityReplay.modality = 'compute';
modalityReplay.binding.modality = 'compute';
assertRejected(modalityReplay, visualOptions, 'binding_replay_mismatch:modality');
const outcomeReplay = structuredClone(visual);
outcomeReplay.outcome = 'refused';
outcomeReplay.binding.outcome = 'refused';
assertRejected(outcomeReplay, visualOptions, 'binding_replay_mismatch:outcome');

const relabeledClockFixture = testClockFixture(controlledClock(), {
  clockDomainId: 'clock-domain:relabeled',
  clockSourceIdentityHash: hash('0'),
  runtimeSessionId: 'runtime-session:relabeled',
  processIdentity: 'process:relabeled',
  evidenceRefs: ['evidence:clock-source:relabeled'],
});
const relabeledManifest = relabeledClockFixture.manifest;
const whollyRelabeled = structuredClone(visual);
whollyRelabeled.clock.domainId = relabeledManifest.clockDomainId;
whollyRelabeled.clock.sourceManifestId = relabeledManifest.manifestId;
whollyRelabeled.clock.sourceIdentityHash = relabeledManifest.clockSourceIdentityHash;
whollyRelabeled.binding.clockDomainId = relabeledManifest.clockDomainId;
whollyRelabeled.binding.clockSourceManifestId = relabeledManifest.manifestId;
whollyRelabeled.binding.clockSourceIdentityHash = relabeledManifest.clockSourceIdentityHash;
whollyRelabeled.binding.runtimeSessionId = relabeledManifest.runtimeSessionId;
whollyRelabeled.binding.processIdentity = relabeledManifest.processIdentity;
for (const phaseValue of whollyRelabeled.phases) {
  for (const attemptValue of phaseValue.attempts) {
    attemptValue.clockDomainId = relabeledManifest.clockDomainId;
  }
}
whollyRelabeled.firstVisibleBoundary.clockDomainId = relabeledManifest.clockDomainId;
assertRejected(whollyRelabeled, visualOptions, 'binding_replay_mismatch:clockDomainId');
assertRejected(
  whollyRelabeled,
  validationOptions(whollyRelabeled.binding, visualManifest),
  'trusted_clock_binding_mismatch:clockDomainId',
);

const missingTrustedManifest = validateGpuHmrTestTimingV3(visual, {
  expectedBinding: visualBinding,
  trustedClockSourceManifest: null,
});
assert.equal(missingTrustedManifest.valid, false);
assert.ok(missingTrustedManifest.gaps.includes('trusted_clock_source_manifest_invalid'));
const forgedTrustedManifest = structuredClone(visualManifest);
forgedTrustedManifest.gpuHmrSuccess = true;
const forgedManifestValidation = validateGpuHmrTestTimingV3ClockSourceManifest(
  forgedTrustedManifest,
);
assert.equal(forgedManifestValidation.valid, false);
assert.ok(forgedManifestValidation.gaps.includes('clock_source_success_claim'));

let coercionCount = 0;
const coercionPrototype = {
  toString() {
    coercionCount += 1;
    return hash('a');
  },
  [Symbol.toPrimitive]() {
    coercionCount += 1;
    return hash('a');
  },
};
const coercionObject = () => Object.create(coercionPrototype);
assert.throws(
  () => createGpuHmrTestTimingV3ClockSourceManifest({
    ...clockManifestInput(),
    recorderImplementationHash: coercionObject(),
  }),
  /timing_v3_clock_source_input_invalid/,
);
const coercionHashRecord = structuredClone(visual);
coercionHashRecord.binding.sourceManifestHash = coercionObject();
assertRejected(
  coercionHashRecord,
  visualOptions,
  'record_object_prototype_invalid:record.binding.sourceManifestHash',
);
const coercionReasonRecord = structuredClone(visual);
phase(coercionReasonRecord, 'durable_persistence').reasonCode = coercionObject();
assertRejected(coercionReasonRecord, visualOptions, 'record_object_prototype_invalid');
const coercionRecordId = structuredClone(visual);
coercionRecordId.recordId = coercionObject();
assertRejected(
  coercionRecordId,
  visualOptions,
  'record_object_prototype_invalid:record.recordId',
);
const coercionManifestId = structuredClone(visualManifest);
coercionManifestId.manifestId = coercionObject();
const coercionManifestValidation = validateGpuHmrTestTimingV3ClockSourceManifest(
  coercionManifestId,
);
assert.equal(coercionManifestValidation.valid, false);
assert.ok(
  coercionManifestValidation.gaps.includes(
    'record_object_prototype_invalid:record.manifestId',
  ),
);
const coercionPlanHash = structuredClone(persistencePlan);
coercionPlanHash.byteHash = coercionObject();
const coercionPlanValidation = validateGpuHmrTestTimingV3PersistenceReceipt(receipt, {
  ...receiptOptions,
  expectedPersistencePlan: coercionPlanHash,
});
assert.equal(coercionPlanValidation.valid, false);
assert.ok(coercionPlanValidation.gaps.includes('expected_persistence_plan_byteHash_invalid'));
const coercionReceiptId = structuredClone(receipt);
coercionReceiptId.receiptId = coercionObject();
const coercionReceiptValidation = validateGpuHmrTestTimingV3PersistenceReceipt(
  coercionReceiptId,
  receiptOptions,
);
assert.equal(coercionReceiptValidation.valid, false);
assert.ok(
  coercionReceiptValidation.gaps.includes(
    'record_object_prototype_invalid:record.receiptId',
  ),
);
assert.equal(coercionCount, 0, 'regex validation must not coerce objects');

const completedWithInapplicableCore = structuredClone(visual);
const inapplicableCompile = phase(completedWithInapplicableCore, 'compile');
inapplicableCompile.disposition = 'not_applicable';
inapplicableCompile.measurementKind = 'none';
inapplicableCompile.reasonCode = 'compile_declared_not_applicable';
inapplicableCompile.evidenceRefs = ['evidence:compile:not-applicable'];
inapplicableCompile.attempts = [];
assertRejected(
  completedWithInapplicableCore,
  visualOptions,
  'completed_required_phase_not_measured:compile',
);
const completedWithUnavailableCore = structuredClone(visual);
const unavailableLoad = phase(completedWithUnavailableCore, 'artifact_load');
unavailableLoad.disposition = 'unavailable';
unavailableLoad.measurementKind = 'none';
unavailableLoad.reasonCode = 'artifact_load_unavailable';
unavailableLoad.evidenceRefs = ['evidence:artifact-load:unavailable'];
unavailableLoad.attempts = [];
assertRejected(
  completedWithUnavailableCore,
  visualOptions,
  'completed_required_phase_not_measured:artifact_load',
);
const completedWithoutRetirement = structuredClone(visual);
const retirement = phase(completedWithoutRetirement, 'retirement');
retirement.disposition = 'not_applicable';
retirement.measurementKind = 'none';
retirement.reasonCode = 'retirement_declared_not_applicable';
retirement.evidenceRefs = ['evidence:retirement:not-applicable'];
retirement.attempts = [];
assertRejected(
  completedWithoutRetirement,
  visualOptions,
  'completed_required_phase_not_measured:retirement',
);
const coldWithoutDiscovery = structuredClone(visual);
const discovery = phase(coldWithoutDiscovery, 'discovery');
discovery.disposition = 'not_applicable';
discovery.measurementKind = 'none';
discovery.reasonCode = 'discovery_declared_not_applicable';
discovery.evidenceRefs = ['evidence:discovery:not-applicable'];
discovery.attempts = [];
assertRejected(coldWithoutDiscovery, visualOptions, 'fresh_cold_ai_phase_not_measured:discovery');

const separatelyClockedDispatchProof = structuredClone(visual);
const forgedDispatchProof = phase(separatelyClockedDispatchProof, 'dispatch_to_output_proof');
forgedDispatchProof.measurementKind = 'observed';
forgedDispatchProof.attempts[0].measurementKind = 'observed';
forgedDispatchProof.attempts[0].startNs = visualDispatch.startNs;
forgedDispatchProof.attempts[0].durationNs = (
  BigInt(forgedDispatchProof.attempts[0].endNs) - BigInt(visualDispatch.startNs)
).toString();
assertRejected(
  separatelyClockedDispatchProof,
  visualOptions,
  'dispatch_to_output_proof_phase_not_derived',
);
assert.throws(
  () => {
    const recorder = createGpuHmrTestTimingV3Recorder({
      clockCapability: visualClockFixture.capability,
      binding: visualBinding,
      totalSource: 'source:validator',
      totalEvidenceRefs: ['evidence:validator:total'],
    });
    recorder.beginAttempt('dispatch_to_output_proof', {
      source: 'source:forged-derived-phase',
      evidenceRefs: ['evidence:forged-derived-phase'],
    });
  },
  /timing_v3_phase_invalid/,
);
assert.throws(
  () => {
    const recorder = createGpuHmrTestTimingV3Recorder({
      clockCapability: visualClockFixture.capability,
      binding: visualBinding,
      totalSource: 'source:validator',
      totalEvidenceRefs: ['evidence:validator:total'],
    });
    recorder.beginAttempt('durable_persistence', {
      source: 'source:self-persistence',
      evidenceRefs: ['evidence:self-persistence'],
    });
  },
  /timing_v3_phase_invalid/,
);

const selfPersistenceClaim = structuredClone(visual);
const selfPersistence = phase(selfPersistenceClaim, 'durable_persistence');
selfPersistence.disposition = 'measured';
selfPersistence.measurementKind = 'observed';
selfPersistence.reasonCode = null;
selfPersistence.attempts = [{
  attempt: 1,
  result: 'completed',
  measurementKind: 'observed',
  startNs: '8000000',
  endNs: '8000010',
  durationNs: '10',
  clockDomainId: visual.clock.domainId,
  source: 'source:self-persistence',
  evidenceRefs: ['evidence:self-persistence'],
}];
selfPersistence.evidenceRefs = ['evidence:self-persistence'];
assertRejected(selfPersistenceClaim, visualOptions, 'timing_record_must_not_claim_self_persistence');

const multipleCompletion = structuredClone(visual);
const outputPhase = phase(multipleCompletion, 'output_ready');
const originalCompletion = outputPhase.attempts.at(-1);
outputPhase.attempts.push({
  ...structuredClone(originalCompletion),
  attempt: outputPhase.attempts.length + 1,
  startNs: (BigInt(originalCompletion.endNs) + 1n).toString(),
  endNs: (BigInt(originalCompletion.endNs) + 2n).toString(),
  durationNs: '1',
});
assertRejected(multipleCompletion, visualOptions, 'exactly_one_completed_attempt_required');
const completedWithOnlyFailedCompile = structuredClone(visual);
for (const attemptValue of phase(completedWithOnlyFailedCompile, 'compile').attempts) {
  attemptValue.result = 'failed';
}
assertRejected(
  completedWithOnlyFailedCompile,
  visualOptions,
  'exactly_one_completed_attempt_required',
);
const failedAfterCompletion = structuredClone(visual);
const compilePhase = phase(failedAfterCompletion, 'compile');
const compileCompletion = compilePhase.attempts.at(-1);
compilePhase.attempts.push({
  ...structuredClone(compileCompletion),
  attempt: compilePhase.attempts.length + 1,
  result: 'failed',
  startNs: (BigInt(compileCompletion.endNs) + 1n).toString(),
  endNs: (BigInt(compileCompletion.endNs) + 2n).toString(),
  durationNs: '1',
});
assertRejected(failedAfterCompletion, visualOptions, 'completion_must_be_terminal');

const aggregateRecorder = createGpuHmrTestTimingV3Recorder({
  clockCapability: visualClockFixture.capability,
  binding: visualBinding,
  totalSource: 'source:validator',
  totalEvidenceRefs: ['evidence:aggregate:total'],
});
const aggregateEvidence = Array.from(
  { length: GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS - 1 },
  (_, index) => `evidence:aggregate:${String(index).padStart(2, '0')}`,
);
const aggregateFirstToken = aggregateRecorder.beginAttempt('compile', {
  source: 'source:compile',
  evidenceRefs: aggregateEvidence,
});
visualClockFixture.clock.tick();
aggregateRecorder.finishAttempt(aggregateFirstToken, {
  result: 'failed',
  evidenceRefs: [],
});
const aggregateSecondToken = aggregateRecorder.beginAttempt('compile', {
  source: 'source:compile',
  evidenceRefs: [aggregateEvidence[0]],
});
visualClockFixture.clock.tick();
assert.throws(
  () => aggregateRecorder.finishAttempt(aggregateSecondToken, {
    result: 'failed',
    evidenceRefs: ['evidence:aggregate:new:1', 'evidence:aggregate:new:2'],
  }),
  (error) => error.details.gaps.includes('phase_aggregate_evidence_limit_exceeded'),
);
const acceptedSecondAttempt = aggregateRecorder.finishAttempt(aggregateSecondToken, {
  result: 'failed',
  evidenceRefs: ['evidence:aggregate:new:1'],
});
assert.equal(acceptedSecondAttempt.attempt, 2);
assert.throws(
  () => aggregateRecorder.beginAttempt('compile', {
    source: 'source:compile',
    evidenceRefs: ['evidence:aggregate:new:2'],
  }),
  (error) => error.details.gaps.includes('phase_aggregate_evidence_limit_exceeded'),
);

const dispatchFailureEvidence = Array.from(
  { length: GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS - 2 },
  (_, index) => `evidence:dispatch-budget:${String(index).padStart(2, '0')}`,
);
const dispatchBudgetClockFixture = testClockFixture(controlledClock(13_000_000n), {
  clockDomainId: 'clock-domain:dispatch-budget',
  clockSourceIdentityHash: hash('6'),
  runtimeSessionId: 'runtime-session:dispatch-budget',
  processIdentity: 'process:dispatch-budget',
  evidenceRefs: ['evidence:clock-source:dispatch-budget'],
});
const dispatchBudgetBinding = binding(dispatchBudgetClockFixture.manifest, {
  runMode: 'warm',
  splitMode: 'reused_ai',
  modality: 'compute',
  editId: 'edit:test:dispatch-budget',
  editHash: hash('7'),
  artifactHash: hash('8'),
});
const dispatchBudgetRecord = completeRecord({
  modality: 'compute',
  clockFixture: dispatchBudgetClockFixture,
  bindingValue: dispatchBudgetBinding,
  dispatchFailureEvidenceRefs: dispatchFailureEvidence,
});
const dispatchBudgetValidation = validateGpuHmrTestTimingV3(
  dispatchBudgetRecord,
  validationOptions(dispatchBudgetBinding, dispatchBudgetClockFixture.manifest),
);
assert.equal(
  dispatchBudgetValidation.valid,
  true,
  dispatchBudgetValidation.gaps.join(', '),
);
const dispatchBudgetPhase = phase(dispatchBudgetRecord, 'dispatch');
assert.deepEqual(
  dispatchBudgetPhase.attempts.map((attemptValue) => attemptValue.result),
  ['failed', 'completed'],
);
assert.equal(dispatchBudgetPhase.evidenceRefs.length, GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS);
const completedDispatchEvidence = dispatchBudgetPhase.attempts[1].evidenceRefs;
const completedOracleEvidence = phase(
  dispatchBudgetRecord,
  'oracle_analysis',
).attempts[0].evidenceRefs;
const derivedDispatchEvidence = phase(
  dispatchBudgetRecord,
  'dispatch_to_output_proof',
).attempts[0].evidenceRefs;
assert.deepEqual(
  derivedDispatchEvidence,
  [...completedDispatchEvidence, ...completedOracleEvidence].sort(),
);
assert.equal(
  derivedDispatchEvidence.includes(dispatchBudgetClockFixture.manifest.manifestId),
  false,
);
assert.equal(
  derivedDispatchEvidence.some((ref) => dispatchFailureEvidence.includes(ref)),
  false,
);

const visualBoundaryAfterCaptureStarted = structuredClone(visual);
visualBoundaryAfterCaptureStarted.firstVisibleBoundary.monotonicNs = phase(
  visualBoundaryAfterCaptureStarted,
  'visual_capture',
).attempts[0].endNs;
assertRejected(
  visualBoundaryAfterCaptureStarted,
  visualOptions,
  'first_visible_boundary_after_capture_started',
);
const visualBoundaryBeforeOutput = structuredClone(visual);
visualBoundaryBeforeOutput.firstVisibleBoundary.monotonicNs = (
  BigInt(phase(visualBoundaryBeforeOutput, 'output_ready').attempts.at(-1).endNs) - 1n
).toString();
assertRejected(
  visualBoundaryBeforeOutput,
  visualOptions,
  'first_visible_boundary_before_output_ready',
);
const computeWithVisibleBoundary = structuredClone(compute);
computeWithVisibleBoundary.firstVisibleBoundary = {
  kind: 'post_dispatch_presentation_complete',
  monotonicNs: compute.firstOutputReadyBoundary.monotonicNs,
  clockDomainId: compute.clock.domainId,
  source: compute.firstOutputReadyBoundary.source,
  evidenceRefs: compute.firstOutputReadyBoundary.evidenceRefs,
};
assertRejected(computeWithVisibleBoundary, computeOptions, 'compute_record_must_not_carry_first_visible_boundary');

for (const invalidNs of ['-0', 'NaN', 'Infinity', '-Infinity']) {
  const invalidTimestamp = structuredClone(visual);
  phase(invalidTimestamp, 'compile').attempts[0].startNs = invalidNs;
  assertRejected(invalidTimestamp, visualOptions, 'start_ns_invalid');
}
for (const counterField of ['phaseAttemptCount', 'phaseFailedAttemptCount']) {
  const negativeZeroSummary = structuredClone(visual);
  negativeZeroSummary.summary[counterField].compile = -0;
  assertRejected(
    negativeZeroSummary,
    visualOptions,
    `summary:${counterField}_negative_zero:compile`,
  );
}
const oversizedDigitTimestamp = structuredClone(visual);
phase(oversizedDigitTimestamp, 'compile').attempts[0].startNs = '9'.repeat(
  GPU_HMR_TEST_TIMING_V3_MAX_NS_DIGITS + 1,
);
assertRejected(oversizedDigitTimestamp, visualOptions, 'start_ns_invalid');
const oversizedBitTimestamp = structuredClone(visual);
phase(oversizedBitTimestamp, 'compile').attempts[0].startNs = (1n << 128n).toString();
assertRejected(oversizedBitTimestamp, visualOptions, 'start_ns_invalid');

const hugeClockString = '9'.repeat(100_000);
const hugeClockCapability = createGpuHmrTestTimingV3TestClockCapability({
  now: () => hugeClockString,
  manifestInput: clockManifestInput({
    clockDomainId: 'clock-domain:huge-clock-string',
    runtimeSessionId: 'runtime-session:huge-clock-string',
    processIdentity: 'process:huge-clock-string',
  }),
});
const hugeClockManifest = getGpuHmrTestTimingV3ClockSourceManifest(hugeClockCapability);
const originalBigInt = globalThis.BigInt;
let oversizedStringBigIntCalls = 0;
try {
  globalThis.BigInt = (...args) => {
    oversizedStringBigIntCalls += 1;
    return originalBigInt(...args);
  };
  assert.throws(
    () => createGpuHmrTestTimingV3Recorder({
      clockCapability: hugeClockCapability,
      binding: binding(hugeClockManifest),
      totalSource: 'source:validator',
      totalEvidenceRefs: ['evidence:validator:total'],
    }),
    /timing_v3_clock_value_invalid/,
  );
} finally {
  globalThis.BigInt = originalBigInt;
}
assert.equal(oversizedStringBigIntCalls, 0);

const hugeBigIntCapability = createGpuHmrTestTimingV3TestClockCapability({
  now: () => 1n << 129n,
  manifestInput: clockManifestInput({
    clockDomainId: 'clock-domain:huge-bigint',
    runtimeSessionId: 'runtime-session:huge-bigint',
    processIdentity: 'process:huge-bigint',
  }),
});
const hugeBigIntManifest = getGpuHmrTestTimingV3ClockSourceManifest(hugeBigIntCapability);
assert.throws(
  () => createGpuHmrTestTimingV3Recorder({
    clockCapability: hugeBigIntCapability,
    binding: binding(hugeBigIntManifest),
    totalSource: 'source:validator',
    totalEvidenceRefs: ['evidence:validator:total'],
  }),
  /timing_v3_clock_value_invalid/,
);
for (const invalidClockValue of [-0, Number.NaN, Number.POSITIVE_INFINITY]) {
  const invalidCapability = createGpuHmrTestTimingV3TestClockCapability({
    now: () => invalidClockValue,
    manifestInput: clockManifestInput({
      clockDomainId: `clock-domain:invalid:${String(invalidClockValue)}`,
      runtimeSessionId: `runtime-session:invalid:${String(invalidClockValue)}`,
      processIdentity: `process:invalid:${String(invalidClockValue)}`,
    }),
  });
  const invalidManifest = getGpuHmrTestTimingV3ClockSourceManifest(invalidCapability);
  assert.throws(
    () => createGpuHmrTestTimingV3Recorder({
      clockCapability: invalidCapability,
      binding: binding(invalidManifest),
      totalSource: 'source:validator',
      totalEvidenceRefs: ['evidence:validator:total'],
    }),
    /timing_v3_clock_value_invalid/,
  );
}

const sequentialClockFixture = testClockFixture(sequentialClock(), {
  clockDomainId: 'clock-domain:sequential',
  clockSourceIdentityHash: hash('0'),
  runtimeSessionId: 'runtime-session:sequential',
  processIdentity: 'process:sequential',
  evidenceRefs: ['evidence:clock-source:sequential'],
});
const sequentialManifest = sequentialClockFixture.manifest;
const sequentialBinding = binding(sequentialManifest, {
  modality: 'compute',
  editId: 'edit:test:sequential',
  editHash: hash('c'),
  artifactHash: hash('d'),
});
const sequential = completeRecord({
  modality: 'compute',
  clockFixture: sequentialClockFixture,
  bindingValue: sequentialBinding,
});
const sequentialValidation = validateGpuHmrTestTimingV3(
  sequential,
  validationOptions(sequentialBinding, sequentialManifest),
);
assert.equal(sequentialValidation.valid, true, sequentialValidation.gaps.join(', '));
assert.ok(sequentialValidation.diagnostics.includes('sequential_timing_placeholder_detected'));

const allZero = structuredClone(visual);
for (const phaseValue of allZero.phases) {
  for (const attemptValue of phaseValue.attempts) {
    attemptValue.startNs = '0';
    attemptValue.endNs = '0';
    attemptValue.durationNs = '0';
  }
}
allZero.firstVisibleBoundary.monotonicNs = '0';
const allZeroValidation = validateGpuHmrTestTimingV3(allZero, visualOptions);
assert.equal(allZeroValidation.valid, false);
assert.equal(allZeroValidation.recomputedSummary, null);
assert.ok(allZeroValidation.diagnostics.includes('all_zero_timing_placeholder_detected'));
assert.ok(allZeroValidation.gaps.some((gap) => gap.includes('zero_duration_rejected')));

const realClockFixture = productionClockFixture({
  recorderImplementationHash: hash('1'),
  clockDomainId: 'clock-domain:hrtime',
  clockSourceIdentityHash: hash('2'),
  runtimeSessionId: 'runtime-session:hrtime',
  processIdentity: `process:pid:${process.pid}`,
  evidenceRefs: ['evidence:clock-source:hrtime'],
});
const realManifest = realClockFixture.manifest;
const realBinding = binding(realManifest, {
  modality: 'compute',
  editId: 'edit:test:hrtime',
  editHash: hash('3'),
  artifactHash: hash('4'),
});
const realTiming = completeRecord({
  modality: 'compute',
  clockFixture: realClockFixture,
  bindingValue: realBinding,
});
const realValidation = validateGpuHmrTestTimingV3(
  realTiming,
  validationOptions(realBinding, realManifest),
);
assert.equal(realValidation.valid, true, realValidation.gaps.join(', '));
assert.ok(BigInt(realTiming.summary.totalValidatorWallNs) > 0n);
assert.equal(realValidation.diagnostics.includes('sequential_timing_placeholder_detected'), false);

let oversizedAttemptElementReads = 0;
const oversizedAttempts = new Array(GPU_HMR_TEST_TIMING_V3_MAX_ATTEMPTS_PER_PHASE + 1);
Object.defineProperty(oversizedAttempts, 0, {
  enumerable: true,
  get() {
    oversizedAttemptElementReads += 1;
    throw new Error('oversized attempt array must not be traversed');
  },
});
const oversizedAttemptRecord = structuredClone(visual);
phase(oversizedAttemptRecord, 'compile').attempts = oversizedAttempts;
assertRejected(oversizedAttemptRecord, visualOptions, 'record_array_limit_exceeded');
assert.equal(oversizedAttemptElementReads, 0);

let oversizedEvidenceElementReads = 0;
const oversizedEvidenceRefs = new Array(GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS + 1);
Object.defineProperty(oversizedEvidenceRefs, 0, {
  enumerable: true,
  get() {
    oversizedEvidenceElementReads += 1;
    throw new Error('oversized evidence array must not be traversed');
  },
});
const oversizedEvidenceRecord = structuredClone(visual);
phase(oversizedEvidenceRecord, 'compile').evidenceRefs = oversizedEvidenceRefs;
assertRejected(oversizedEvidenceRecord, visualOptions, 'record_array_limit_exceeded');
assert.equal(oversizedEvidenceElementReads, 0);

const allocationGuardPlan = {
  ...persistencePlan,
  byteLength: GPU_HMR_TEST_TIMING_V3_MAX_RECORD_BYTES + 1,
  serializedRecord: 'x'.repeat(GPU_HMR_TEST_TIMING_V3_MAX_RECORD_BYTES + 1),
};
const originalJsonParse = JSON.parse;
const originalBufferFrom = Buffer.from;
let oversizedPlanJsonParseCalls = 0;
let oversizedPlanBufferAllocations = 0;
let allocationGuardValidation;
try {
  JSON.parse = (...args) => {
    oversizedPlanJsonParseCalls += 1;
    return originalJsonParse(...args);
  };
  Buffer.from = (...args) => {
    oversizedPlanBufferAllocations += 1;
    return originalBufferFrom(...args);
  };
  allocationGuardValidation = validateGpuHmrTestTimingV3PersistenceReceipt(receipt, {
    ...receiptOptions,
    expectedPersistencePlan: allocationGuardPlan,
  });
} finally {
  JSON.parse = originalJsonParse;
  Buffer.from = originalBufferFrom;
}
assert.equal(allocationGuardValidation.valid, false);
assert.ok(
  allocationGuardValidation.gaps.includes(
    'expected_persistence_plan_serialized_record_limit_exceeded',
  ),
);
assert.equal(oversizedPlanJsonParseCalls, 0);
assert.equal(oversizedPlanBufferAllocations, 0);

const oversizedRecord = structuredClone(visual);
oversizedRecord.unexpected = Array.from(
  { length: 2_048 },
  (_, index) => `${String(index).padStart(4, '0')}:${'x'.repeat(1_050)}`,
);
assertRejected(oversizedRecord, visualOptions, 'record_byte_limit_exceeded');
const tooDeep = structuredClone(visual);
let nested = {};
tooDeep.unexpected = nested;
for (let index = 0; index < 14; index += 1) {
  nested.next = {};
  nested = nested.next;
}
assertRejected(tooDeep, visualOptions, 'record_depth_limit_exceeded');
function wideTree(depth) {
  if (depth === 0) return null;
  return Array.from({ length: 10 }, () => wideTree(depth - 1));
}
const tooManyNodes = structuredClone(visual);
tooManyNodes.unexpected = wideTree(6);
assertRejected(tooManyNodes, visualOptions, 'record_node_limit_exceeded');

const unknownField = structuredClone(visual);
unknownField.projectName = 'non-authoritative';
assertRejected(unknownField, visualOptions, 'record_field_unexpected:projectName');
const millisecondAlias = structuredClone(visual);
phase(millisecondAlias, 'compile').attempts[0].duration_ms = 1;
assertRejected(millisecondAlias, visualOptions, 'field_unexpected:duration_ms');
const forgedSuccess = structuredClone(visual);
forgedSuccess.fullRuntimeProven = true;
assertRejected(forgedSuccess, visualOptions, 'authority_or_success_claim_rejected');

let hiddenSuccessGetterReads = 0;
const inheritedSuccessPrototype = {};
Object.defineProperty(inheritedSuccessPrototype, 'gpuHmrSuccess', {
  enumerable: true,
  get() {
    hiddenSuccessGetterReads += 1;
    return true;
  },
});
const inheritedSuccess = structuredClone(visual);
Object.setPrototypeOf(inheritedSuccess, inheritedSuccessPrototype);
assertRejected(inheritedSuccess, visualOptions, 'record_object_prototype_invalid:record');

const nonEnumerableSuccess = structuredClone(visual);
Object.defineProperty(nonEnumerableSuccess, 'fullRuntimeProven', {
  enumerable: false,
  value: true,
});
assertRejected(
  nonEnumerableSuccess,
  visualOptions,
  'record_non_enumerable_property_rejected:record.fullRuntimeProven',
);

const symbolSuccess = structuredClone(visual);
Object.defineProperty(symbolSuccess, Symbol('gpuHmrSuccess'), {
  enumerable: true,
  get() {
    hiddenSuccessGetterReads += 1;
    return true;
  },
});
assertRejected(symbolSuccess, visualOptions, 'record_symbol_property_rejected:record');

const accessorSuccess = structuredClone(visual);
Object.defineProperty(accessorSuccess, 'fullRuntimeProven', {
  enumerable: true,
  get() {
    hiddenSuccessGetterReads += 1;
    return true;
  },
});
assertRejected(
  accessorSuccess,
  visualOptions,
  'record_accessor_property_rejected:record.fullRuntimeProven',
);
assert.equal(hiddenSuccessGetterReads, 0);

assert.deepEqual(
  visual.phases.map((entry) => entry.phase),
  GPU_HMR_TEST_TIMING_V3_PHASES,
);
console.log('gpu-hmr timing-v3 self-check passed');
