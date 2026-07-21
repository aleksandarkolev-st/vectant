#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  externalProjectTimingMetrics,
  hipModuleRuntimeTimingMetrics,
  hiprtWarmTimingMetrics,
  realRocmTimingMetrics,
  timingMetricsFromTrustedV3,
  webGpuRuntimeComputeTimingMetrics,
  webGpuRuntimeVisualTimingMetrics,
  GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
  GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
} from '../lib/gpu-hmr-timing-metrics.mjs';
import {
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GpuHmrTestTimingRecorder,
} from '../lib/gpu-hmr-test-timing-v2.mjs';
import {
  GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON,
  captureGpuHmrTestTimingV3ClockReading,
  createGpuHmrTestTimingV3ClockCapability,
  createGpuHmrTestTimingV3PersistenceOperation,
  createGpuHmrTestTimingV3PersistenceReceipt,
  createGpuHmrTestTimingV3Recorder,
  createGpuHmrTestTimingV3TestClockCapability,
  getGpuHmrTestTimingV3ClockSourceManifest,
  prepareGpuHmrTestTimingV3Persistence,
  validateGpuHmrTestTimingV3,
} from '../lib/gpu-hmr-test-timing-v3.mjs';
import {
  classifyReports,
  compactRow,
  deduplicateGpuHmrTestTimingV2Rows,
  hasMeaningfulMetrics,
} from '../gpu-hmr-timing-metrics-summary.mjs';

const REQUIRED_KEYS = [
  'schemaVersion',
  'source',
  'metricClock',
  'metric_clock',
  'metricUnit',
  'metric_unit',
  'metricScope',
  'metric_scope',
  'cacheState',
  'cache_state',
  'profileId',
  'projectName',
  'proofMode',
  'status',
  'telemetryOnly',
  'evidenceAuthority',
  'proofVerdict',
  'reportedStatus',
  'totalWallMs',
  'totalWallTiming',
  'setupBuildMs',
  'setupBuildTiming',
  'adapterBuildMs',
  'runtimeReadyMs',
  'timeToFirstOutputReadyMs',
  'timeToFirstOutputReadyTiming',
  'initialCompileWallMs',
  'sourceWriteMs',
  'modelAvailabilityCheckMs',
  'modelProvenance',
  'aiDeltaWallMs',
  'hotHmrCompileWallMs',
  'sameProcessLiveRecompileMs',
  'sameProcessTriggerWaitMs',
  'hotReloadSignalMs',
  'editToFirstVisualMs',
  'beforeCaptureMs',
  'afterCaptureMs',
  'visualDiffMs',
  'teardownMs',
  'normalizedTimings',
  'normalized_timings',
  'clockEvidence',
  'clock_evidence',
  'diagnosticMetadata',
  'diagnostic_metadata',
  'screenshotCaptureMs',
  'screenshotCaptureTiming',
  'visualEvidence',
  'phases',
];

const NORMALIZED_KEYS = [
  'staticDiscoveryTimeMs',
  'aiContractSynthesisTimeMs',
  'modelAvailabilityCheckTimeMs',
  'artifactHashTimeMs',
  'adapterGenerationTimeMs',
  'deviceCompileWallTimeMs',
  'artifactLoadTimeMs',
  'epochPublishTimeMs',
  'dispatchTraceTimeMs',
  'runtimeProbeTimeMs',
  'timeToFirstOutputReadyMs',
  'oracleAnalysisTimeMs',
  'triggerToVisibleTimeMs',
  'screenshotCaptureTimeMs',
  'dispatchToOutputProofTimeMs',
  'totalValidatorWallTimeMs',
];

function assertCommonShape(metrics) {
  assert.equal(metrics.schemaVersion, GPU_HMR_TIMING_METRICS_SCHEMA_VERSION);
  for (const key of REQUIRED_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(metrics, key), `missing key ${key}`);
  }
  assert.ok(Array.isArray(metrics.phases), 'phases must be an array');
  assert.equal(typeof metrics.visualEvidence, 'object');
  assert.equal(metrics.telemetryOnly, true);
  assert.equal(metrics.evidenceAuthority, GPU_HMR_TIMING_TELEMETRY_AUTHORITY);
  assert.equal(metrics.proofVerdict, 'not_evaluated_by_timing_summary');
  assert.equal(typeof metrics.normalizedTimings, 'object');
  assert.equal(typeof metrics.normalized_timings, 'object');
  assert.equal(typeof metrics.clockEvidence, 'object');
  assert.equal(metrics.metricUnit, 'ms');
  assert.equal(metrics.metric_unit, 'ms');
  for (const key of NORMALIZED_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(metrics.normalizedTimings, key), `missing normalized key ${key}`);
  }
}

function trustedTimingProjection(metrics) {
  return {
    timingV3Validation: metrics.timingV3Validation,
    metricClock: metrics.metricClock,
    metricUnit: metrics.metricUnit,
    totalWallTiming: metrics.totalWallTiming,
    setupBuildTiming: metrics.setupBuildTiming,
    screenshotCaptureTiming: metrics.screenshotCaptureTiming,
    dispatchToOutputProofTiming: metrics.dispatchToOutputProofTiming,
    proofFinalizationTiming: metrics.proofFinalizationTiming,
    editToFirstVisualTiming: metrics.editToFirstVisualTiming,
    outputToFirstVisualTiming: metrics.outputToFirstVisualTiming,
    timeToFirstOutputReadyTiming: metrics.timeToFirstOutputReadyTiming,
    normalizedTimings: metrics.normalizedTimings,
    clockEvidence: metrics.clockEvidence,
    phases: metrics.phases,
  };
}

function controlledClock(initialNs) {
  let currentNs = initialNs;
  return {
    now: () => currentNs,
    tick: (durationNs) => {
      currentNs += durationNs;
    },
  };
}

function measurePhase(recorder, clock, phaseKey, durationNs) {
  recorder.startPhase(phaseKey);
  clock.tick(durationNs);
  recorder.finishPhase(phaseKey);
}

function summaryRows(report, name) {
  const filePath = path.join(process.cwd(), 'tmp', `${name}.json`);
  const classified = classifyReports(report, filePath);
  return {
    classified,
    rows: classified.map((entry) => compactRow({
      ...entry,
      filePath,
      updatedAt: '2026-07-16T00:00:00.000Z',
    })),
  };
}

function reverseObjectKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeyOrder(nested)]),
  );
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function measureV3Phase(recorder, clock, phaseName, durationNs) {
  const token = recorder.beginAttempt(phaseName, {
    source: `smoke:${phaseName}`,
    evidenceRefs: [`evidence:${phaseName}`],
  });
  clock.tick(durationNs);
  recorder.finishAttempt(token, {
    result: 'completed',
    evidenceRefs: [],
  });
}

function createTrustedV3Fixture({
  editId = 'edit:identifier-containing-cyclic-is-valid',
  domainId = 'clock-domain:identifier-containing-cyclic-is-valid',
  modality = 'visual',
} = {}) {
  const clock = controlledClock(1_000_000n);
  const clockCapability = createGpuHmrTestTimingV3TestClockCapability({
    now: clock.now,
    manifestInput: {
      recorderImplementationHash: sha256('timing-metrics-smoke-recorder'),
      clockDomainId: domainId,
      clockSourceIdentityHash: sha256('timing-metrics-smoke-clock-source'),
      runtimeSessionId: 'runtime-session:timing-metrics-smoke',
      processIdentity: 'process:timing-metrics-smoke',
      evidenceRefs: ['evidence:clock-source'],
    },
  });
  const manifest = getGpuHmrTestTimingV3ClockSourceManifest(clockCapability);
  const binding = {
    runMode: 'hot_delta',
    splitMode: 'reused_ai',
    modality,
    outcome: 'completed',
    sourceManifestHash: sha256('source-manifest'),
    editId,
    editHash: sha256('edit'),
    artifactHash: sha256('artifact'),
    proofLedgerId: 'proof-ledger:timing-metrics-smoke',
    runtimeProofId: 'runtime-proof:timing-metrics-smoke',
    runtimeSessionId: manifest.runtimeSessionId,
    processIdentity: manifest.processIdentity,
    clockSourceManifestId: manifest.manifestId,
    clockSourceIdentityHash: manifest.clockSourceIdentityHash,
    clockDomainId: manifest.clockDomainId,
  };
  const recorder = createGpuHmrTestTimingV3Recorder({
    clockCapability,
    binding,
    totalSource: 'smoke:total-validator-wall',
    totalEvidenceRefs: ['evidence:total-validator-wall'],
  });

  measureV3Phase(recorder, clock, 'discovery', 1_000_000n);
  measureV3Phase(recorder, clock, 'provider_availability', 1_000_000n);
  measureV3Phase(recorder, clock, 'ai_split', 1_000_000n);
  measureV3Phase(recorder, clock, 'compile', 2_000_000n);
  measureV3Phase(recorder, clock, 'artifact_load', 1_000_000n);
  measureV3Phase(recorder, clock, 'epoch_publish', 1_000_000n);
  measureV3Phase(recorder, clock, 'dispatch', 1_000_000n);
  measureV3Phase(recorder, clock, 'output_ready', 1_000_000n);
  if (modality === 'visual') {
    recorder.markPresentationComplete({
      source: 'smoke:first-visible',
      evidenceRefs: ['evidence:first-visible'],
    });
    measureV3Phase(recorder, clock, 'visual_capture', 3_000_000n);
    measureV3Phase(recorder, clock, 'visual_analysis', 2_000_000n);
  } else {
    for (const phaseName of ['visual_capture', 'visual_analysis']) {
      recorder.markNotApplicable(
        phaseName,
        GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON,
        [`evidence:${phaseName}:compute-modality`],
      );
    }
  }
  measureV3Phase(recorder, clock, 'oracle_analysis', 1_000_000n);
  measureV3Phase(recorder, clock, 'retirement', 1_000_000n);
  measureV3Phase(recorder, clock, 'proof_finalization', 2_000_000n);
  measureV3Phase(recorder, clock, 'cleanup', 1_000_000n);

  const record = recorder.finalize();
  const validationOptions = {
    expectedBinding: binding,
    trustedClockSourceManifest: manifest,
  };
  const validation = validateGpuHmrTestTimingV3(record, validationOptions);
  assert.equal(validation.valid, true, validation.gaps.join(','));
  return {
    clock,
    clockCapability,
    manifest,
    binding,
    record,
    validationOptions,
    trust: Object.freeze({
      record,
      trustedClockCapability: clockCapability,
    }),
  };
}

function reportForTrustedFixture(fixture, {
  backend,
  capability,
  projectId = null,
  ...overrides
}) {
  const report = {
    status: fixture.binding.outcome === 'completed'
      ? 'pass'
      : fixture.binding.outcome === 'failed'
        ? 'fail'
        : 'refused',
    outputModality: fixture.binding.modality,
    timingBackend: backend,
    timingCapability: capability,
    runMode: fixture.binding.runMode,
    splitMode: fixture.binding.splitMode,
    sourceManifestHash: fixture.binding.sourceManifestHash,
    editId: fixture.binding.editId,
    editHash: fixture.binding.editHash,
    artifactHash: fixture.binding.artifactHash,
    proofLedgerId: fixture.binding.proofLedgerId,
    runtimeProofId: fixture.binding.runtimeProofId,
    runtimeSessionId: fixture.binding.runtimeSessionId,
    processIdentity: fixture.binding.processIdentity,
    clockSourceManifestId: fixture.binding.clockSourceManifestId,
    clockSourceIdentityHash: fixture.binding.clockSourceIdentityHash,
    clockDomainId: fixture.binding.clockDomainId,
    ...overrides,
  };
  if (projectId !== null) report.projectId = projectId;
  return report;
}

function advanceProductionClock() {
  const startedNs = process.hrtime.bigint();
  while (process.hrtime.bigint() <= startedNs) {
    // The production capability requires strictly increasing observed endpoints.
  }
}

function measureProductionV3Phase(recorder, phaseName) {
  const token = recorder.beginAttempt(phaseName, {
    source: `smoke:persistence:${phaseName}`,
    evidenceRefs: [`evidence:persistence:${phaseName}`],
  });
  advanceProductionClock();
  recorder.finishAttempt(token, { result: 'completed', evidenceRefs: [] });
}

function createPersistedComputeV3Fixture() {
  const clockCapability = createGpuHmrTestTimingV3ClockCapability({
    recorderImplementationHash: sha256('timing-metrics-persisted-recorder'),
    clockDomainId: 'clock-domain:timing-metrics-persisted-record',
    clockSourceIdentityHash: sha256('timing-metrics-persisted-clock'),
    runtimeSessionId: 'runtime-session:timing-metrics-persisted',
    processIdentity: `process:timing-metrics-persisted:${process.pid}`,
    evidenceRefs: ['evidence:persistence:record-clock'],
  });
  const manifest = getGpuHmrTestTimingV3ClockSourceManifest(clockCapability);
  const binding = Object.freeze({
    runMode: 'warm',
    splitMode: 'reused_ai',
    modality: 'compute',
    outcome: 'completed',
    sourceManifestHash: sha256('persisted-source-manifest'),
    editId: 'edit:timing-metrics-persisted',
    editHash: sha256('persisted-edit'),
    artifactHash: sha256('persisted-artifact'),
    proofLedgerId: 'proof-ledger:timing-metrics-persisted',
    runtimeProofId: 'runtime-proof:timing-metrics-persisted',
    runtimeSessionId: manifest.runtimeSessionId,
    processIdentity: manifest.processIdentity,
    clockSourceManifestId: manifest.manifestId,
    clockSourceIdentityHash: manifest.clockSourceIdentityHash,
    clockDomainId: manifest.clockDomainId,
  });
  const recorder = createGpuHmrTestTimingV3Recorder({
    clockCapability,
    binding,
    totalSource: 'smoke:persistence:total-validator-wall',
    totalEvidenceRefs: ['evidence:persistence:total-validator-wall'],
  });
  for (const phaseName of [
    'discovery',
    'provider_availability',
    'ai_split',
    'compile',
    'artifact_load',
    'epoch_publish',
    'dispatch',
    'output_ready',
  ]) {
    measureProductionV3Phase(recorder, phaseName);
  }
  for (const phaseName of ['visual_capture', 'visual_analysis']) {
    recorder.markNotApplicable(
      phaseName,
      GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON,
      [`evidence:persistence:${phaseName}:compute-modality`],
    );
  }
  for (const phaseName of [
    'oracle_analysis',
    'retirement',
    'proof_finalization',
    'cleanup',
  ]) {
    measureProductionV3Phase(recorder, phaseName);
  }
  advanceProductionClock();
  const record = recorder.finalize();
  const timingRecordValidationOptions = Object.freeze({
    expectedBinding: binding,
    trustedClockSourceManifest: manifest,
  });
  const recordValidation = validateGpuHmrTestTimingV3(
    record,
    timingRecordValidationOptions,
  );
  assert.equal(recordValidation.valid, true, recordValidation.gaps.join(','));
  const persistencePlan = prepareGpuHmrTestTimingV3Persistence(
    record,
    timingRecordValidationOptions,
  );
  const writerClockCapability = createGpuHmrTestTimingV3ClockCapability({
    recorderImplementationHash: sha256('timing-metrics-persistence-writer'),
    clockDomainId: 'clock-domain:timing-metrics-persistence-writer',
    clockSourceIdentityHash: sha256('timing-metrics-persistence-writer-clock'),
    runtimeSessionId: binding.runtimeSessionId,
    processIdentity: `process:timing-metrics-persistence-writer:${process.pid}`,
    evidenceRefs: ['evidence:persistence:writer-clock'],
  });
  const writerIdentity = 'writer:timing-metrics-smoke';
  const destinationIdentity = 'destination:timing-metrics-smoke';
  const persistenceOperation = createGpuHmrTestTimingV3PersistenceOperation({
    persistencePlan,
    timingRecordValidationOptions,
    writerClockCapability,
    writerIdentity,
    destinationIdentity,
  });
  const writeStartReading = captureGpuHmrTestTimingV3ClockReading(
    persistenceOperation,
    'write_start',
  );
  advanceProductionClock();
  const writeEndReading = captureGpuHmrTestTimingV3ClockReading(
    persistenceOperation,
    'write_end',
  );
  advanceProductionClock();
  const verifiedAtReading = captureGpuHmrTestTimingV3ClockReading(
    persistenceOperation,
    'read_verify',
  );
  const persistenceReceipt = createGpuHmrTestTimingV3PersistenceReceipt({
    persistenceOperation,
    persistencePlan,
    timingRecordValidationOptions,
    writerClockCapability,
    writerIdentity,
    destinationIdentity,
    writeStartReading,
    writeEndReading,
    writeSource: 'smoke:persistence:write',
    writeEvidenceRefs: ['evidence:persistence:write'],
    readableAfterWrite: {
      verified: true,
      verifiedAtReading,
      readerIdentity: 'reader:timing-metrics-smoke',
      observedByteLength: persistencePlan.byteLength,
      observedByteHash: persistencePlan.byteHash,
      evidenceRefs: ['evidence:persistence:read'],
    },
  });
  const persistenceReceiptValidationOptions = Object.freeze({
    expectedPersistencePlan: persistencePlan,
    timingRecordValidationOptions,
    trustedWriterClockCapability: writerClockCapability,
    expectedWriterIdentity: writerIdentity,
    expectedDestinationIdentity: destinationIdentity,
  });
  return {
    binding,
    manifest,
    record,
    persistenceReceipt,
    persistenceReceiptValidationOptions,
    trust: Object.freeze({
      record,
      persistenceReceipt,
      persistenceReceiptValidationOptions,
    }),
  };
}

function mutableRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function phaseAttempt(record, phaseName) {
  return record.phases.find((phase) => phase.phase === phaseName).attempts[0];
}

const trustedV3 = createTrustedV3Fixture();
assert.match(trustedV3.record.binding.editId, /cyclic/);
assert.ok(Object.isFrozen(trustedV3.record));
assert.ok(Object.isFrozen(trustedV3.record.phases));
assert.ok(Object.isFrozen(trustedV3.trust));

const trustedVisualReport = reportForTrustedFixture(trustedV3, {
  backend: 'rocm',
  capability: 'real_runtime_visual',
  slug: 'generic-v3-smoke',
  target_name: 'generic-v3-target',
});
const validTrustedIntegration = realRocmTimingMetrics(
  trustedVisualReport,
  trustedV3.trust,
);
assertCommonShape(validTrustedIntegration);
assert.equal(validTrustedIntegration.timingV3Validation.state, 'validated');
assert.equal(validTrustedIntegration.metricClock, 'monotonic_ns');
assert.equal(validTrustedIntegration.clockEvidence.clockDomain, trustedV3.manifest.clockDomainId);
assert.equal(validTrustedIntegration.setupBuildMs, 2);
assert.equal(validTrustedIntegration.setupBuildTiming.state, 'measured');
assert.equal(validTrustedIntegration.normalizedTimings.screenshotCaptureTimeMs, 3);
assert.equal(validTrustedIntegration.screenshotCaptureMs, 3);
assert.equal(validTrustedIntegration.dispatchToOutputProofTiming.state, 'measured');
assert.equal(validTrustedIntegration.normalizedTimings.dispatchToOutputProofTimeMs, 7);
assert.equal(validTrustedIntegration.proofFinalizationMs, 2);
assert.equal(validTrustedIntegration.totalWallMs, 19);
assert.equal(validTrustedIntegration.editToFirstVisualMs, 9);
assert.equal(validTrustedIntegration.outputToFirstVisualMs, 0);
assert.equal(validTrustedIntegration.outputToFirstVisualTiming.state, 'measured');
assert.equal(validTrustedIntegration.outputToFirstVisualTiming.durationMs, 0);
assert.equal(validTrustedIntegration.timeToFirstOutputReadyMs, null);
assert.equal(validTrustedIntegration.timeToFirstOutputReadyTiming.state, 'unavailable');
assert.equal(validTrustedIntegration.telemetryOnly, true);
assert.equal(validTrustedIntegration.evidenceAuthority, GPU_HMR_TIMING_TELEMETRY_AUTHORITY);
assert.equal(validTrustedIntegration.proofVerdict, 'not_evaluated_by_timing_summary');
assert.equal(validTrustedIntegration.timingV3Validation.acceptedForGpuHmr, false);
assert.equal(validTrustedIntegration.timingV3Validation.gpuHmrSuccess, false);
assert.equal(validTrustedIntegration.acceptedForGpuHmr, false);
assert.equal(validTrustedIntegration.gpuHmrSuccess, false);
for (const timing of [
  validTrustedIntegration.totalWallTiming,
  validTrustedIntegration.setupBuildTiming,
  validTrustedIntegration.screenshotCaptureTiming,
  validTrustedIntegration.dispatchToOutputProofTiming,
  validTrustedIntegration.editToFirstVisualTiming,
  validTrustedIntegration.proofFinalizationTiming,
]) {
  assert.equal(timing.state, 'measured');
  assert.equal(timing.clockSource, 'monotonic_ns');
  assert.equal(timing.clockDomain, trustedV3.manifest.clockDomainId);
  assert.equal(timing.clockSourceManifestId, trustedV3.manifest.manifestId);
  assert.ok(timing.endpointPairs.length > 0);
}

const genericTrustedIntegration = timingMetricsFromTrustedV3(
  { ...trustedVisualReport, projectId: 'project:timing-metrics-smoke' },
  trustedV3.trust,
  {
    source: 'generic_project_runtime_visual',
    expectedModality: 'compute',
    expectedBackend: 'caller-selected-backend',
    expectedCapability: 'caller-selected-capability',
    expectedProjectId: 'project:caller-selected',
  },
);
assert.equal(genericTrustedIntegration.timingV3Validation.state, 'validated');
assert.equal(genericTrustedIntegration.totalWallMs, 19);
assert.equal(genericTrustedIntegration.source, 'generic_project_runtime_visual');

const compatibilityWrapperViews = [
  webGpuRuntimeVisualTimingMetrics(trustedVisualReport, trustedV3.trust),
  webGpuRuntimeComputeTimingMetrics(trustedVisualReport, trustedV3.trust),
  hipModuleRuntimeTimingMetrics(trustedVisualReport, trustedV3.trust),
  externalProjectTimingMetrics(trustedVisualReport, trustedV3.trust),
  hiprtWarmTimingMetrics(trustedVisualReport, trustedV3.trust),
  realRocmTimingMetrics(trustedVisualReport, trustedV3.trust),
];
for (const wrapperView of compatibilityWrapperViews) {
  assert.equal(wrapperView.timingV3Validation.state, 'validated');
  assert.equal(wrapperView.totalWallMs, 19);
  assert.equal(wrapperView.totalWallTiming.timingRecordId, trustedV3.record.recordId);
}
assert.equal(compatibilityWrapperViews[1].editToFirstVisualMs, 9);
assert.equal(compatibilityWrapperViews[1].timeToFirstOutputReadyMs, null);

const oversizedScreenshotDurations = Array.from({ length: 257 }, (_, index) => ({
  label: index === 0 ? 'before' : index === 256 ? 'after' : `diagnostic-${index}`,
  elapsedMs: index + 1,
  accepted_as_visual_evidence: false,
}));
const oversizedLegacyReport = {
  ...trustedVisualReport,
  screenshots: oversizedScreenshotDurations,
};
const oversizedLegacyViews = [
  timingMetricsFromTrustedV3(oversizedLegacyReport, trustedV3.trust, {
    source: 'generic_oversized_legacy',
    legacy: {
      screenshotCapture: oversizedScreenshotDurations.map((shot) => shot.elapsedMs),
    },
  }),
  webGpuRuntimeVisualTimingMetrics(oversizedLegacyReport, trustedV3.trust),
  webGpuRuntimeComputeTimingMetrics(oversizedLegacyReport, trustedV3.trust),
  hipModuleRuntimeTimingMetrics(oversizedLegacyReport, trustedV3.trust),
  externalProjectTimingMetrics(oversizedLegacyReport, trustedV3.trust),
  hiprtWarmTimingMetrics(oversizedLegacyReport, trustedV3.trust),
  realRocmTimingMetrics(oversizedLegacyReport, trustedV3.trust),
];
const oversizedTrustedProjection = trustedTimingProjection(oversizedLegacyViews[0]);
for (const wrapperView of oversizedLegacyViews) {
  assert.equal(wrapperView.timingV3Validation.state, 'validated');
  assert.equal(wrapperView.totalWallMs, 19);
  assert.equal(wrapperView.totalWallTiming.timingRecordId, trustedV3.record.recordId);
  assert.deepEqual(trustedTimingProjection(wrapperView), oversizedTrustedProjection);
}
for (const diagnosticUnavailable of [
  oversizedLegacyViews[0],
  oversizedLegacyViews[oversizedLegacyViews.length - 1],
]) {
  assert.equal(diagnosticUnavailable.diagnosticMetadata.state, 'unavailable');
  assert.ok(diagnosticUnavailable.diagnosticMetadata.gaps.some(
    (gap) => gap.includes('array_length_invalid'),
  ));
}

const oversizedDiagnosticStringView = webGpuRuntimeVisualTimingMetrics(
  {
    ...trustedVisualReport,
    modelProvenance: { note: 'x'.repeat((1024 * 1024) + 1) },
  },
  trustedV3.trust,
);
const oversizedDiagnosticObject = Object.fromEntries(
  Array.from({ length: 4_100 }, (_, index) => [`diagnostic_${index}`, index]),
);
const oversizedDiagnosticObjectView = webGpuRuntimeVisualTimingMetrics(
  { ...trustedVisualReport, modelProvenance: oversizedDiagnosticObject },
  trustedV3.trust,
);
for (const oversizedDiagnosticView of [
  oversizedDiagnosticStringView,
  oversizedDiagnosticObjectView,
]) {
  assert.equal(oversizedDiagnosticView.timingV3Validation.state, 'validated');
  assert.deepEqual(
    trustedTimingProjection(oversizedDiagnosticView),
    trustedTimingProjection(validTrustedIntegration),
  );
  assert.equal(oversizedDiagnosticView.diagnosticMetadata.state, 'unavailable');
}

const trustedComputeV3 = createTrustedV3Fixture({
  editId: 'edit:timing-metrics-compute',
  domainId: 'clock-domain:timing-metrics-compute',
  modality: 'compute',
});
const trustedComputeReport = reportForTrustedFixture(trustedComputeV3, {
  backend: 'webgpu',
  capability: 'runtime_compute',
  profile: { id: 'trusted-webgpu-compute' },
  computeOracleArtifacts: {
    raw_readback_hash: sha256('trusted-compute-readback'),
    raw_readback_byte_length: 32,
    deterministic_slice_hash: sha256('trusted-compute-slice'),
    rendered_card_png: 'trusted-compute-card.png',
  },
});
const validTrustedCompute = webGpuRuntimeComputeTimingMetrics(
  trustedComputeReport,
  trustedComputeV3.trust,
);
assert.equal(validTrustedCompute.timingV3Validation.state, 'validated');
assert.equal(validTrustedCompute.runtimeReadyMs, 1);
assert.equal(validTrustedCompute.timeToFirstOutputReadyMs, 9);
assert.equal(validTrustedCompute.timeToFirstOutputReadyTiming.state, 'measured');
assert.equal(validTrustedCompute.timeToFirstOutputReadyTiming.endpointPairs.length, 1);
assert.equal(
  validTrustedCompute.timeToFirstOutputReadyTiming.endpointPairs[0].clockDomain,
  trustedComputeV3.manifest.clockDomainId,
);
assert.equal(validTrustedCompute.normalizedTimings.runtimeProbeTimeMs, 1);
assert.equal(validTrustedCompute.normalizedTimings.timeToFirstOutputReadyMs, 9);
assert.equal(validTrustedCompute.editToFirstVisualMs, null);
assert.equal(validTrustedCompute.editToFirstVisualTiming.state, 'unavailable');
assert.equal(validTrustedCompute.screenshotCaptureTiming.state, 'unavailable');
assert.equal(validTrustedCompute.computeEvidence.computeCardAccepted, true);

for (const [field, replacement] of [
  ['sourceManifestHash', sha256('replayed-project-source-manifest')],
  ['editId', 'edit:replayed-into-another-subject'],
  ['editHash', sha256('replayed-edit')],
  ['artifactHash', sha256('replayed-artifact')],
  ['proofLedgerId', 'proof-ledger:replayed-into-another-ledger'],
  ['runtimeProofId', 'runtime-proof:replayed-into-another-report'],
]) {
  const replayedAcrossSubject = realRocmTimingMetrics(
    { ...trustedVisualReport, [field]: replacement },
    trustedV3.trust,
  );
  assert.equal(replayedAcrossSubject.timingV3Validation.state, 'unavailable');
  assert.equal(replayedAcrossSubject.totalWallMs, null);
  assert.ok(replayedAcrossSubject.timingV3Validation.gaps.includes(
    `binding_replay_mismatch:${field}`,
  ));
}

const nestedProjectSubjectReport = {
  ...trustedVisualReport,
  project: { sourceManifestHash: trustedV3.binding.sourceManifestHash },
};
delete nestedProjectSubjectReport.sourceManifestHash;
const nestedProjectSubjectValid = realRocmTimingMetrics(
  nestedProjectSubjectReport,
  trustedV3.trust,
);
assert.equal(nestedProjectSubjectValid.timingV3Validation.state, 'validated');
const nestedProjectSubjectReplay = realRocmTimingMetrics(
  {
    ...nestedProjectSubjectReport,
    project: { sourceManifestHash: sha256('another-project-source-manifest') },
  },
  trustedV3.trust,
);
assert.equal(nestedProjectSubjectReplay.totalWallMs, null);
assert.ok(nestedProjectSubjectReplay.timingV3Validation.gaps.includes(
  'binding_replay_mismatch:sourceManifestHash',
));

const omittedReportBinding = { ...trustedVisualReport };
delete omittedReportBinding.runtimeProofId;
const omissionDowngradeRejected = realRocmTimingMetrics(
  omittedReportBinding,
  trustedV3.trust,
);
assert.equal(omissionDowngradeRejected.totalWallMs, null);
assert.equal(
  omissionDowngradeRejected.timingV3Validation.reason,
  'trusted_v3_report_binding_unavailable',
);
assert.ok(omissionDowngradeRejected.timingV3Validation.gaps.includes(
  'report_binding_missing:runtimeProofId',
));

const diagnosticProjectLabelOne = realRocmTimingMetrics(
  { ...trustedVisualReport, projectId: 'project:diagnostic-one' },
  trustedV3.trust,
);
const diagnosticProjectLabelTwo = realRocmTimingMetrics(
  { ...trustedVisualReport, projectId: 'project:diagnostic-two' },
  trustedV3.trust,
);
assert.equal(diagnosticProjectLabelOne.timingV3Validation.state, 'validated');
assert.equal(diagnosticProjectLabelTwo.timingV3Validation.state, 'validated');
assert.equal(diagnosticProjectLabelOne.totalWallMs, diagnosticProjectLabelTwo.totalWallMs);
assert.equal(
  diagnosticProjectLabelOne.totalWallTiming.timingRecordId,
  diagnosticProjectLabelTwo.totalWallTiming.timingRecordId,
);

const contradictoryTrustedOutcome = realRocmTimingMetrics(
  { ...trustedVisualReport, failed: true },
  trustedV3.trust,
);
assert.equal(contradictoryTrustedOutcome.status, 'refused');
assert.equal(contradictoryTrustedOutcome.totalWallMs, null);
assert.equal(contradictoryTrustedOutcome.outcomeConflict, true);
assert.ok(contradictoryTrustedOutcome.timingV3Validation.gaps.includes(
  'report_outcome_missing_or_conflicting',
));

const diagnosticBackendLabelsIgnored = realRocmTimingMetrics(
  {
    ...trustedVisualReport,
    backend: 'webgpu',
    timingCapability: 'caller-diagnostic-capability',
  },
  trustedV3.trust,
);
assert.equal(diagnosticBackendLabelsIgnored.timingV3Validation.state, 'validated');

const contradictoryBindingAliases = realRocmTimingMetrics(
  {
    ...trustedVisualReport,
    runtime_proof_id: 'runtime-proof:conflicting-alias',
  },
  trustedV3.trust,
);
assert.equal(contradictoryBindingAliases.totalWallMs, null);
assert.ok(contradictoryBindingAliases.timingV3Validation.gaps.includes(
  'report_binding_conflict_or_invalid:runtimeProofId',
));

const reportModalityMismatch = webGpuRuntimeComputeTimingMetrics(
  reportForTrustedFixture(trustedV3, {
    backend: 'webgpu',
    capability: 'runtime_compute',
    outputModality: 'compute',
  }),
  trustedV3.trust,
);
assert.equal(reportModalityMismatch.timingV3Validation.state, 'unavailable');
assert.equal(reportModalityMismatch.timeToFirstOutputReadyMs, null);
assert.equal(reportModalityMismatch.editToFirstVisualMs, null);
assert.ok(reportModalityMismatch.timingV3Validation.gaps.includes(
  'binding_replay_mismatch:modality',
));

const callerMintedBothSides = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: trustedV3.record,
    expectedBinding: { ...trustedV3.binding },
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(callerMintedBothSides.totalWallMs, null);
assert.equal(callerMintedBothSides.timingV3Validation.reason, 'trusted_v3_input_shape_invalid');

const persistedComputeV3 = createPersistedComputeV3Fixture();
const persistedComputeReport = reportForTrustedFixture(persistedComputeV3, {
  backend: 'webgpu',
  capability: 'runtime_compute',
  profile: { id: 'persisted-webgpu-compute' },
});
const validPersistedReceipt = webGpuRuntimeComputeTimingMetrics(
  persistedComputeReport,
  persistedComputeV3.trust,
);
assert.equal(validPersistedReceipt.timingV3Validation.state, 'validated');
assert.equal(
  validPersistedReceipt.timingV3Validation.trustPath,
  'verified_persistence_receipt',
);
assert.equal(validPersistedReceipt.timeToFirstOutputReadyTiming.state, 'measured');
assert.ok(Object.isFrozen(persistedComputeV3.persistenceReceipt));
assert.ok(Object.isFrozen(persistedComputeV3.persistenceReceiptValidationOptions));
assert.ok(Object.isFrozen(persistedComputeV3.trust));

const callerReceiptBindingIgnored = webGpuRuntimeComputeTimingMetrics(
  persistedComputeReport,
  {
    record: persistedComputeV3.record,
    persistenceReceipt: persistedComputeV3.persistenceReceipt,
    persistenceReceiptValidationOptions: {
      ...persistedComputeV3.persistenceReceiptValidationOptions,
      timingRecordValidationOptions: {
        ...persistedComputeV3.persistenceReceiptValidationOptions.timingRecordValidationOptions,
        expectedBinding: {
          ...persistedComputeV3.binding,
          runtimeProofId: 'runtime-proof:caller-chosen-replacement',
        },
      },
    },
  },
);
assert.equal(callerReceiptBindingIgnored.timingV3Validation.state, 'validated');
assert.equal(
  callerReceiptBindingIgnored.timingV3Validation.trustPath,
  'verified_persistence_receipt',
);

for (const [field, replacement] of [
  ['sourceManifestHash', sha256('persisted-replay-project-source')],
  ['editHash', sha256('persisted-replay-edit')],
  ['proofLedgerId', 'proof-ledger:persisted-replay-target'],
  ['runtimeProofId', 'runtime-proof:persisted-replay-target'],
]) {
  const persistedReceiptReplay = webGpuRuntimeComputeTimingMetrics(
    { ...persistedComputeReport, [field]: replacement },
    persistedComputeV3.trust,
  );
  assert.equal(persistedReceiptReplay.totalWallMs, null);
  assert.ok(persistedReceiptReplay.timingV3Validation.gaps.some(
    (gap) => gap.includes(`binding_replay_mismatch:${field}`),
  ));
}

const persistedReceiptDiagnosticLabels = webGpuRuntimeVisualTimingMetrics(
  {
    ...persistedComputeReport,
    backend: 'diagnostic-backend-only',
    projectId: 'project:diagnostic-only',
  },
  persistedComputeV3.trust,
);
assert.equal(persistedReceiptDiagnosticLabels.timingV3Validation.state, 'validated');
assert.equal(
  persistedReceiptDiagnosticLabels.timingV3Validation.trustPath,
  'verified_persistence_receipt',
);

let nestedReceiptProxyTrapCalls = 0;
const nestedReceiptProxy = new Proxy(persistedComputeV3.persistenceReceipt, {
  get(target, key, receiver) {
    nestedReceiptProxyTrapCalls += 1;
    return Reflect.get(target, key, receiver);
  },
  ownKeys(target) {
    nestedReceiptProxyTrapCalls += 1;
    return Reflect.ownKeys(target);
  },
});
const nestedReceiptProxyRejected = webGpuRuntimeComputeTimingMetrics(
  persistedComputeReport,
  {
    record: persistedComputeV3.record,
    persistenceReceipt: nestedReceiptProxy,
    persistenceReceiptValidationOptions:
      persistedComputeV3.persistenceReceiptValidationOptions,
  },
);
assert.equal(nestedReceiptProxyRejected.totalWallMs, null);
assert.equal(
  nestedReceiptProxyRejected.timingV3Validation.reason,
  'trusted_v3_input_proxy_rejected',
);
assert.equal(nestedReceiptProxyTrapCalls, 0);

let receiptOptionsProxyTrapCalls = 0;
const nestedReceiptRecordOptionsProxy = new Proxy(
  persistedComputeV3.persistenceReceiptValidationOptions.timingRecordValidationOptions,
  {
    get(target, key, receiver) {
      receiptOptionsProxyTrapCalls += 1;
      return Reflect.get(target, key, receiver);
    },
    ownKeys(target) {
      receiptOptionsProxyTrapCalls += 1;
      return Reflect.ownKeys(target);
    },
  },
);
const nestedReceiptOptionsProxyRejected = webGpuRuntimeComputeTimingMetrics(
  persistedComputeReport,
  {
    record: persistedComputeV3.record,
    persistenceReceipt: persistedComputeV3.persistenceReceipt,
    persistenceReceiptValidationOptions: {
      ...persistedComputeV3.persistenceReceiptValidationOptions,
      timingRecordValidationOptions: nestedReceiptRecordOptionsProxy,
    },
  },
);
assert.equal(nestedReceiptOptionsProxyRejected.totalWallMs, null);
assert.equal(
  nestedReceiptOptionsProxyRejected.timingV3Validation.reason,
  'trusted_v3_input_proxy_rejected',
);
assert.equal(receiptOptionsProxyTrapCalls, 0);

let nestedReceiptGetterCalls = 0;
const nestedAccessorReceipt = mutableRecord(persistedComputeV3.persistenceReceipt);
Object.defineProperty(nestedAccessorReceipt.write, 'startNs', {
  enumerable: true,
  get() {
    nestedReceiptGetterCalls += 1;
    return persistedComputeV3.persistenceReceipt.write.startNs;
  },
});
const nestedReceiptAccessorRejected = webGpuRuntimeComputeTimingMetrics(
  persistedComputeReport,
  {
    record: persistedComputeV3.record,
    persistenceReceipt: nestedAccessorReceipt,
    persistenceReceiptValidationOptions:
      persistedComputeV3.persistenceReceiptValidationOptions,
  },
);
assert.equal(nestedReceiptAccessorRejected.totalWallMs, null);
assert.equal(
  nestedReceiptAccessorRejected.timingV3Validation.reason,
  'trusted_v3_input_accessor_or_hidden_property_rejected',
);
assert.equal(nestedReceiptGetterCalls, 0);

const forgedSelfConsistentRecorder = realRocmTimingMetrics({
  status: 'pass',
  metric_clock: 'monotonic_ns',
  metric_clock_domain: 'clock-domain:caller-chosen:monotonic_ns',
  timing_producer_id: 'caller-chosen',
  timing_recorder: {
    schema_version: 'synthi.gpu.hmr.timing_recorder.v1',
    producer_id: 'caller-chosen',
    clock: {
      source: 'monotonic_ns',
      unit: 'ns',
      domain: 'clock-domain:caller-chosen:monotonic_ns',
      producer_id: 'caller-chosen',
    },
  },
  started_monotonic_ns: '100',
  finished_monotonic_ns: '200',
  duration_monotonic_ns: '100',
  dispatch_proof: { dispatchTimestamps: [100] },
  output_proof: { outputOracle: { readbackTimestamp: 200 } },
});
assert.equal(forgedSelfConsistentRecorder.totalWallMs, null);
assert.equal(forgedSelfConsistentRecorder.totalWallTiming.state, 'unavailable');
assert.equal(
  forgedSelfConsistentRecorder.totalWallTiming.reason,
  'trusted_v3_input_missing',
);
assert.equal(forgedSelfConsistentRecorder.dispatchToOutputProofTiming.state, 'unavailable');

const callerSuppliedUntrustedRecord = realRocmTimingMetrics({
  status: 'pass',
  timingV3: trustedV3.record,
  timing_v3: trustedV3.record,
});
assert.equal(callerSuppliedUntrustedRecord.totalWallMs, null);
assert.equal(callerSuppliedUntrustedRecord.timingV3Validation.reason, 'trusted_v3_input_missing');

const incompleteTrustInput = realRocmTimingMetrics(
  { status: 'pass' },
  { record: trustedV3.record },
);
assert.equal(incompleteTrustInput.totalWallMs, null);
assert.equal(incompleteTrustInput.timingV3Validation.reason, 'trusted_v3_input_shape_invalid');

const rawManifestOptionsAreNotTrust = realRocmTimingMetrics(
  { status: 'pass' },
  { record: trustedV3.record, validationOptions: trustedV3.validationOptions },
);
assert.equal(rawManifestOptionsAreNotTrust.totalWallMs, null);
assert.equal(
  rawManifestOptionsAreNotTrust.timingV3Validation.reason,
  'trusted_v3_input_shape_invalid',
);

const mismatchClock = controlledClock(5_000_000n);
const mismatchCapability = createGpuHmrTestTimingV3TestClockCapability({
  now: mismatchClock.now,
  manifestInput: {
    recorderImplementationHash: sha256('different-recorder'),
    clockDomainId: 'clock-domain:different-session',
    clockSourceIdentityHash: sha256('different-clock-source'),
    runtimeSessionId: 'runtime-session:different',
    processIdentity: 'process:different',
    evidenceRefs: ['evidence:different-clock'],
  },
});
const manifestMismatch = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: trustedV3.record,
    trustedClockCapability: mismatchCapability,
  },
);
assert.equal(manifestMismatch.totalWallMs, null);
assert.equal(manifestMismatch.timingV3Validation.state, 'unavailable');
assert.ok(manifestMismatch.timingV3Validation.gaps.some(
  (gap) => gap.startsWith('report_clock_context_mismatch:'),
));

const wallMixedRecord = mutableRecord(trustedV3.record);
wallMixedRecord.clock.kind = 'wall_ms';
const wallMixed = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: wallMixedRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(wallMixed.totalWallTiming.state, 'unavailable');
assert.ok(wallMixed.timingV3Validation.gaps.includes('clock_kind_invalid'));

const missingEndpointRecord = mutableRecord(trustedV3.record);
delete phaseAttempt(missingEndpointRecord, 'compile').endNs;
const missingEndpoint = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: missingEndpointRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(missingEndpoint.setupBuildTiming.state, 'unavailable');
assert.ok(missingEndpoint.timingV3Validation.gaps.some(
  (gap) => gap.includes('field_missing:endNs'),
));

const reversedEndpointRecord = mutableRecord(trustedV3.record);
const reversedCompile = phaseAttempt(reversedEndpointRecord, 'compile');
reversedCompile.endNs = (BigInt(reversedCompile.startNs) - 1n).toString();
const reversedEndpoint = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: reversedEndpointRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(reversedEndpoint.setupBuildTiming.state, 'unavailable');
assert.ok(reversedEndpoint.timingV3Validation.gaps.some(
  (gap) => gap.includes('end_before_start'),
));

const overflowEndpointRecord = mutableRecord(trustedV3.record);
phaseAttempt(overflowEndpointRecord, 'compile').endNs = '1'.padEnd(41, '0');
const overflowEndpoint = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: overflowEndpointRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(overflowEndpoint.setupBuildTiming.state, 'unavailable');
assert.ok(overflowEndpoint.timingV3Validation.gaps.some(
  (gap) => gap.includes('end_ns_invalid'),
));

for (const invalidEndpoint of [
  false,
  true,
  '',
  ' ',
  {},
  -0,
  NaN,
  Infinity,
  -Infinity,
]) {
  const invalidEndpointRecord = mutableRecord(trustedV3.record);
  phaseAttempt(invalidEndpointRecord, 'compile').endNs = invalidEndpoint;
  const invalidEndpointMetrics = realRocmTimingMetrics(
    trustedVisualReport,
    {
      record: invalidEndpointRecord,
      trustedClockCapability: trustedV3.clockCapability,
    },
  );
  assert.equal(invalidEndpointMetrics.setupBuildTiming.state, 'unavailable');
  assert.equal(invalidEndpointMetrics.setupBuildMs, null);
}

const forgedDomainRecord = mutableRecord(trustedV3.record);
forgedDomainRecord.clock.domainId = 'clock-domain:forged';
forgedDomainRecord.binding.clockDomainId = 'clock-domain:forged';
for (const phaseRecord of forgedDomainRecord.phases) {
  for (const attempt of phaseRecord.attempts) {
    attempt.clockDomainId = 'clock-domain:forged';
  }
}
for (const boundaryName of ['firstVisibleBoundary', 'firstOutputReadyBoundary']) {
  if (forgedDomainRecord[boundaryName]) {
    forgedDomainRecord[boundaryName].clockDomainId = 'clock-domain:forged';
  }
}
const forgedDomain = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: forgedDomainRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(forgedDomain.totalWallTiming.state, 'unavailable');
assert.ok(forgedDomain.timingV3Validation.gaps.includes(
  'trusted_clock_binding_mismatch:clockDomainId',
));

let getterCalls = 0;
const getterRecord = mutableRecord(trustedV3.record);
Object.defineProperty(getterRecord, 'schema', {
  enumerable: true,
  configurable: true,
  get() {
    getterCalls += 1;
    return trustedV3.record.schema;
  },
});
const getterRejected = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: getterRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(getterRejected.totalWallTiming.state, 'unavailable');
assert.equal(getterCalls, 0);
assert.ok(getterRejected.timingV3Validation.gaps.some(
  (gap) => gap.includes('accessor_or_hidden_property_rejected'),
));

let trustGetterCalls = 0;
const accessorTrust = {
  trustedClockCapability: trustedV3.clockCapability,
};
Object.defineProperty(accessorTrust, 'record', {
  enumerable: true,
  get() {
    trustGetterCalls += 1;
    return trustedV3.record;
  },
});
const accessorTrustRejected = realRocmTimingMetrics(
  trustedVisualReport,
  accessorTrust,
);
assert.equal(accessorTrustRejected.totalWallTiming.state, 'unavailable');
assert.equal(
  accessorTrustRejected.timingV3Validation.reason,
  'trusted_v3_input_accessor_or_hidden_property_rejected',
);
assert.equal(trustGetterCalls, 0);

let proxyGetCalls = 0;
const hostileProxy = new Proxy(mutableRecord(trustedV3.record), {
  get(target, key, receiver) {
    proxyGetCalls += 1;
    return Reflect.get(target, key, receiver);
  },
});
const proxyRejected = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: hostileProxy,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(proxyRejected.totalWallTiming.state, 'unavailable');
assert.equal(proxyRejected.timingV3Validation.reason, 'trusted_v3_input_proxy_rejected');
assert.equal(proxyGetCalls, 0);

let nestedPhaseProxyTrapCalls = 0;
const nestedPhaseProxyRecord = mutableRecord(trustedV3.record);
nestedPhaseProxyRecord.phases = new Proxy(nestedPhaseProxyRecord.phases, {
  get(target, key, receiver) {
    nestedPhaseProxyTrapCalls += 1;
    return Reflect.get(target, key, receiver);
  },
  ownKeys(target) {
    nestedPhaseProxyTrapCalls += 1;
    return Reflect.ownKeys(target);
  },
  getOwnPropertyDescriptor(target, key) {
    nestedPhaseProxyTrapCalls += 1;
    return Reflect.getOwnPropertyDescriptor(target, key);
  },
});
const nestedPhaseProxyRejected = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: nestedPhaseProxyRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(nestedPhaseProxyRejected.totalWallMs, null);
assert.equal(
  nestedPhaseProxyRejected.timingV3Validation.reason,
  'trusted_v3_input_proxy_rejected',
);
assert.ok(nestedPhaseProxyRejected.timingV3Validation.gaps.some(
  (gap) => gap.endsWith('$.record.phases'),
));
assert.equal(nestedPhaseProxyTrapCalls, 0);

let nestedEventGetterCalls = 0;
const nestedEventAccessorRecord = mutableRecord(trustedV3.record);
const nestedEvent = {};
Object.defineProperty(nestedEvent, 'monotonicNs', {
  enumerable: true,
  get() {
    nestedEventGetterCalls += 1;
    return '1';
  },
});
nestedEventAccessorRecord.events = [nestedEvent];
const nestedEventAccessorRejected = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: nestedEventAccessorRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(nestedEventAccessorRejected.totalWallMs, null);
assert.equal(
  nestedEventAccessorRejected.timingV3Validation.reason,
  'trusted_v3_input_accessor_or_hidden_property_rejected',
);
assert.equal(nestedEventGetterCalls, 0);

let reportArrayProxyTrapCalls = 0;
const reportArrayProxy = new Proxy([], {
  get(target, key, receiver) {
    reportArrayProxyTrapCalls += 1;
    return Reflect.get(target, key, receiver);
  },
  ownKeys(target) {
    reportArrayProxyTrapCalls += 1;
    return Reflect.ownKeys(target);
  },
});
const nestedReportProxyRejected = realRocmTimingMetrics(
  { ...trustedVisualReport, reportBindingEvidence: [reportArrayProxy] },
  trustedV3.trust,
);
assert.equal(nestedReportProxyRejected.totalWallMs, null);
assert.equal(
  nestedReportProxyRejected.timingV3Validation.reason,
  'trusted_v3_report_material_invalid',
);
assert.equal(reportArrayProxyTrapCalls, 0);

let genericOptionGetterCalls = 0;
const hostileGenericMetadata = {};
Object.defineProperty(hostileGenericMetadata, 'projectId', {
  enumerable: true,
  get() {
    genericOptionGetterCalls += 1;
    return 'project:hostile';
  },
});
const hostileGenericOptionsRejected = timingMetricsFromTrustedV3(
  trustedVisualReport,
  trustedV3.trust,
  {
    source: 'hostile-generic-options',
    expectedModality: 'visual',
    expectedBackend: 'rocm',
    expectedCapability: 'real_runtime_visual',
    modelProvenance: hostileGenericMetadata,
  },
);
assert.equal(hostileGenericOptionsRejected.totalWallMs, 19);
assert.equal(hostileGenericOptionsRejected.timingV3Validation.state, 'validated');
assert.deepEqual(
  trustedTimingProjection(hostileGenericOptionsRejected),
  trustedTimingProjection(validTrustedIntegration),
);
assert.equal(
  hostileGenericOptionsRejected.diagnosticMetadata.reason,
  'timing_metrics_options_accessor_or_hidden_property_rejected',
);
assert.equal(hostileGenericOptionsRejected.diagnosticMetadata.state, 'unavailable');
assert.equal(genericOptionGetterCalls, 0);

const deepDagRecord = mutableRecord(trustedV3.record);
const sharedRoot = {};
let deepCursor = sharedRoot;
for (let depth = 0; depth < 20; depth += 1) {
  deepCursor.next = {};
  deepCursor = deepCursor.next;
}
deepDagRecord.deepLeft = sharedRoot;
deepDagRecord.deepRight = sharedRoot;
const deepDagRejected = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: deepDagRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(deepDagRejected.totalWallTiming.state, 'unavailable');
assert.ok(deepDagRejected.timingV3Validation.gaps.includes('record_depth_limit_exceeded'));

const cyclicRecord = mutableRecord(trustedV3.record);
cyclicRecord.structuralCycle = cyclicRecord;
const cycleRejected = realRocmTimingMetrics(
  trustedVisualReport,
  {
    record: cyclicRecord,
    trustedClockCapability: trustedV3.clockCapability,
  },
);
assert.equal(cycleRejected.totalWallTiming.state, 'unavailable');
assert.ok(cycleRejected.timingV3Validation.gaps.some(
  (gap) => gap.startsWith('trusted_v3_input_cycle_rejected:'),
));

const webgpu = webGpuRuntimeVisualTimingMetrics({
  gpuHmrSuccess: true,
  profile: { id: 'webgpu-wgsl-runtime-triangle' },
  metrics: {
    changedPixelRatio: 0.29,
    meanAbsDelta8bit: 37,
    visiblePixelCount: 67713,
  },
  timings: {
    trigger_to_visible_time: 67_000_000,
    screenshot_capture_time: 40_000_000,
    dispatch_to_output_proof_time: 55_000_000,
    total_validator_wall_time: 951_000_000,
  },
});
assertCommonShape(webgpu);
assert.equal(webgpu.status, 'pass');
assert.equal(webgpu.editToFirstVisualMs, null);
assert.equal(webgpu.editToFirstVisualTiming.state, 'unavailable');
assert.deepEqual(webgpu.editToFirstVisualTiming.legacyValuesMs, [67]);
assert.equal(webgpu.normalizedTimings.triggerToVisibleTimeMs, null);
assert.equal(webgpu.normalizedTimings.screenshotCaptureTimeMs, null);
assert.equal(webgpu.screenshotCaptureMs, null);
assert.equal(webgpu.normalizedTimings.dispatchToOutputProofTimeMs, null);
assert.equal(webgpu.totalWallMs, null);
assert.equal(webgpu.visualEvidence.changedPixelRatio, 0.29);

const conflictingLegacyTimingAliases = webGpuRuntimeVisualTimingMetrics({
  gpuHmrSuccess: false,
  timings: {
    trigger_to_visible_time: 67_000_000,
    triggerToVisibleTime: 68_000_000,
  },
});
assert.equal(conflictingLegacyTimingAliases.editToFirstVisualMs, null);
assert.equal(conflictingLegacyTimingAliases.editToFirstVisualTiming.state, 'unavailable');
assert.deepEqual(conflictingLegacyTimingAliases.editToFirstVisualTiming.legacyValuesMs, []);

const external = externalProjectTimingMetrics({
  profile: { id: 'external-profile', project: { name: 'External project' } },
  proofMode: 'external_runtime_screenshot',
  status: 'pass',
  timings: {
    buildMs: 100,
    editToScreenshotMs: 400,
    totalMs: 600,
  },
  mcp: {
    modelProvenance: { expectedDeltaModel: 'generic-delta-model' },
  },
  screenshots: [
    { label: 'before', elapsedMs: 111 },
    { label: 'after', elapsedMs: 222 },
  ],
});
assertCommonShape(external);
assert.equal(external.setupBuildMs, null);
assert.deepEqual(external.setupBuildTiming.legacyValuesMs, [100]);
assert.equal(external.editToFirstVisualMs, null);
assert.deepEqual(external.editToFirstVisualTiming.legacyValuesMs, [400]);
assert.equal(external.normalizedTimings.screenshotCaptureTimeMs, null);
assert.deepEqual(external.screenshotCaptureTiming.legacyValuesMs, [111, 222]);
assert.equal(external.totalWallMs, null);
assert.equal(external.modelProvenance.expectedDeltaModel, 'generic-delta-model');

const hiprt = hiprtWarmTimingMetrics({
  accepted: true,
  profile: { id: 'hiprt-profile' },
  repo: { target: 'HIPRT target' },
  timings: {
    totalWallMs: 1000,
    sameProcessAdapterBuildMs: 300,
    sameProcessTriggerWaitMs: 2,
    changedHostWallMs: 120,
  },
  runtime: {
    baseline: { hostWallMs: 100 },
    changed: { hostWallMs: 120, triggerTouchMs: 1, totalHostWallMs: 180 },
  },
});
assertCommonShape(hiprt);
assert.equal(hiprt.setupBuildMs, null);
assert.equal(hiprt.editToFirstVisualMs, null);
assert.equal(hiprt.hotReloadSignalMs, null);
assert.equal(hiprt.totalWallMs, null);

const rocm = realRocmTimingMetrics({
  status: 'pass',
  slug: 'real-rocm-profile',
  target_name: 'real-rocm-target',
  duration_ms: 2000,
  phases: [
    {
      name: 'upstream_gpu_build_run',
      timings: 'configure_ms=10 build_ms=20 run_ms=30',
    },
    {
      name: 'hot_delta',
      wait_hmr_elapsed_ms: 50,
      wait_call_wall_ms: 55,
    },
  ],
  screenshots: [{ elapsedMs: 40, accepted_as_visual_evidence: true }],
  hotSignalMs: 50,
});
assertCommonShape(rocm);
assert.equal(rocm.setupBuildMs, null);
assert.deepEqual(rocm.setupBuildTiming.legacyValuesMs, [10, 20]);
assert.equal(rocm.hotReloadSignalMs, null);
assert.deepEqual(rocm.hotReloadSignalTiming.legacyValuesMs, [50, 55]);
assert.equal(rocm.editToFirstVisualMs, null);
assert.ok(rocm.editToFirstVisualTiming.legacyValuesMs.includes(50));
assert.equal(rocm.screenshotCaptureTiming.state, 'unavailable');
assert.deepEqual(rocm.screenshotCaptureTiming.legacyValuesMs, [40]);
assert.equal(rocm.totalWallMs, null);

const webgpuCompute = webGpuRuntimeComputeTimingMetrics({
  gpuHmrSuccess: true,
  profile: { id: 'webgpu-compute-profile' },
  computeOracleArtifacts: {
    raw_readback_hash: `sha256:${'d'.repeat(64)}`,
    raw_readback_byte_length: 32,
    deterministic_slice_hash: `sha256:${'e'.repeat(64)}`,
    rendered_card_png: 'card.png',
  },
  timings: {
    trigger_to_visible_time: 67_000_000,
    dispatch_to_output_proof_time: 55_000_000,
    total_validator_wall_time: 951_000_000,
  },
});
assertCommonShape(webgpuCompute);
assert.equal(webgpuCompute.editToFirstVisualMs, null);
assert.equal(webgpuCompute.dispatchToOutputProofTiming.state, 'unavailable');
assert.equal(webgpuCompute.computeEvidence.computeCardAccepted, true);
assert.equal(webgpuCompute.visualEvidence.accepted, false);

const conflictingProofObjectAliases = webGpuRuntimeComputeTimingMetrics({
  gpuHmrSuccess: false,
  computeOracleArtifacts: { raw_readback_hash: sha256('one') },
  compute_oracle_artifacts: { raw_readback_hash: sha256('two') },
});
assert.equal(conflictingProofObjectAliases.computeEvidence.rawReadbackHash, null);
assert.equal(conflictingProofObjectAliases.dispatchToOutputProofTiming.state, 'unavailable');

for (const invalidScalar of [
  false,
  true,
  '',
  ' ',
  {},
  [],
  -0,
  NaN,
  Infinity,
  -Infinity,
]) {
  const rejectedScalar = webGpuRuntimeVisualTimingMetrics({
    gpuHmrSuccess: false,
    timings: { trigger_to_visible_time: invalidScalar },
  });
  assert.equal(rejectedScalar.editToFirstVisualMs, null);
  assert.deepEqual(rejectedScalar.editToFirstVisualTiming.legacyValuesMs, []);
}

const canonicalLegacyZero = webGpuRuntimeVisualTimingMetrics({
  gpuHmrSuccess: false,
  timings: { trigger_to_visible_time: '0' },
});
assert.equal(canonicalLegacyZero.editToFirstVisualTiming.state, 'unavailable');
assert.deepEqual(canonicalLegacyZero.editToFirstVisualTiming.legacyValuesMs, [0]);

const conflictingOutcome = realRocmTimingMetrics({
  accepted: true,
  failed: true,
  status: 'pass',
  screenshots: [{ accepted_as_visual_evidence: true }],
});
assert.equal(conflictingOutcome.status, 'refused');
assert.equal(conflictingOutcome.reportedStatus, 'refused');
assert.equal(conflictingOutcome.outcomeConflict, true);
assert.equal(conflictingOutcome.visualEvidence.accepted, false);
assert.equal(conflictingOutcome.proofVerdict, 'not_evaluated_by_timing_summary');

const conflictingStatusAlias = realRocmTimingMetrics({
  status: 'pass',
  reported_status: 'fail',
  outcome: 'failed',
});
assert.equal(conflictingStatusAlias.status, 'refused');
assert.equal(conflictingStatusAlias.outcomeConflict, true);

const conflictingAcceptedAliases = realRocmTimingMetrics({
  accepted: true,
  is_accepted: false,
});
assert.equal(conflictingAcceptedAliases.status, 'refused');
assert.equal(conflictingAcceptedAliases.outcomeConflict, true);

const consistentOutcomeAliases = realRocmTimingMetrics({
  accepted: true,
  is_accepted: true,
  failed: false,
  status: 'pass',
  reportedStatus: 'pass',
});
assert.equal(consistentOutcomeAliases.status, 'pass');
assert.equal(consistentOutcomeAliases.outcomeConflict, false);

let statusGetterCalls = 0;
const accessorOutcome = {};
Object.defineProperty(accessorOutcome, 'status', {
  enumerable: true,
  get() {
    statusGetterCalls += 1;
    return 'pass';
  },
});
const accessorOutcomeRejected = realRocmTimingMetrics(accessorOutcome);
assert.equal(accessorOutcomeRejected.status, 'refused');
assert.equal(accessorOutcomeRejected.outcomeConflict, true);
assert.equal(statusGetterCalls, 0);

let reportProxyGetCalls = 0;
const reportProxy = new Proxy({ status: 'pass' }, {
  get(target, key, receiver) {
    reportProxyGetCalls += 1;
    return Reflect.get(target, key, receiver);
  },
});
const reportProxyRejected = realRocmTimingMetrics(reportProxy);
assert.equal(reportProxyRejected.status, 'refused');
assert.equal(reportProxyRejected.outcomeConflict, true);
assert.equal(reportProxyGetCalls, 0);

assert.notDeepEqual(
  validTrustedIntegration.outputToFirstVisualTiming,
  callerSuppliedUntrustedRecord.outputToFirstVisualTiming,
);
assert.equal(validTrustedIntegration.outputToFirstVisualTiming.durationMs, 0);
assert.equal(callerSuppliedUntrustedRecord.outputToFirstVisualTiming.durationMs, null);

const visualClock = controlledClock(1_000_000n);
const visualRecorder = new GpuHmrTestTimingRecorder({ clock: visualClock.now });
visualClock.tick(5_000_000n);
const visualPass = visualRecorder.finalize({
  outcome: 'pass',
  visualCapable: true,
  terminalReason: 'timing_smoke_unavailable',
});
const visualSummary = summaryRows(visualPass, 'timing-v2-visual-pass');
const visualTimingRow = visualSummary.rows[0];
assert.equal(visualSummary.classified.length, 1);
assert.equal(visualSummary.classified[0].kind, 'gpu_hmr_test_timing_v2');
assert.equal(hasMeaningfulMetrics(
  visualSummary.classified[0].metrics,
  visualSummary.classified[0].kind,
), true);
assert.equal(visualTimingRow.outcome, 'pass');
assert.equal(visualTimingRow.valid, true);
assert.equal(visualTimingRow.complete, false);
assert.equal(visualTimingRow.totalWallMs, 5);
assert.equal(visualTimingRow.phases.trigger_to_visible.state, 'unavailable');
assert.ok(visualTimingRow.completenessGaps.includes(
  'visual_phase_not_measured:trigger_to_visible',
));

const computeClock = controlledClock(10_000_000n);
const computeRecorder = new GpuHmrTestTimingRecorder({ clock: computeClock.now });
computeClock.tick(7_000_000n);
const computePass = computeRecorder.finalize({
  outcome: 'pass',
  visualCapable: false,
  terminalReason: 'timing_smoke_unavailable',
  notApplicableReason: 'timing_smoke_not_applicable',
});
const computeTimingRow = summaryRows(computePass, 'timing-v2-compute-pass').rows[0];
assert.equal(computeTimingRow.outcome, 'pass');
assert.equal(computeTimingRow.valid, true);
assert.equal(computeTimingRow.complete, false);
assert.equal(computeTimingRow.totalWallMs, 7);
for (const phaseKey of ['trigger_to_visible', 'screenshot_capture', 'visual_analysis']) {
  assert.equal(computeTimingRow.phases[phaseKey].state, 'not_applicable');
  assert.equal(computeTimingRow.phases[phaseKey].durationNs, null);
  assert.equal(computeTimingRow.phases[phaseKey].durationMs, null);
}

const refusalClock = controlledClock(20_000_000n);
const refusalRecorder = new GpuHmrTestTimingRecorder({ clock: refusalClock.now });
measurePhase(refusalRecorder, refusalClock, 'cold_intake', 1_000_000n);
measurePhase(refusalRecorder, refusalClock, 'discovery', 2_000_000n);
const refusal = refusalRecorder.finalize({
  outcome: 'refused',
  visualCapable: false,
  terminalReason: 'timing_smoke_refused',
  notApplicableReason: 'timing_smoke_not_applicable',
});
const refusalTimingRow = summaryRows(refusal, 'timing-v2-refusal').rows[0];
assert.equal(refusalTimingRow.outcome, 'refused');
assert.equal(refusalTimingRow.valid, true);
assert.equal(refusalTimingRow.complete, false);
assert.equal(refusalTimingRow.phases.compile.state, 'unavailable');
assert.ok(refusalTimingRow.blockingGaps.includes('phase_unavailable:compile'));

const failureClock = controlledClock(30_000_000n);
const failureRecorder = new GpuHmrTestTimingRecorder({ clock: failureClock.now });
let thrownFailure;
try {
  failureRecorder.startPhase('compile');
  failureClock.tick(3_000_000n);
  throw new Error('timing_smoke_injected_failure');
} catch {
  thrownFailure = failureRecorder.finalize({
    outcome: 'failed',
    visualCapable: true,
    terminalReason: 'timing_smoke_exception',
  });
}
const failureTimingRow = summaryRows(thrownFailure, 'timing-v2-thrown-failure').rows[0];
assert.equal(failureTimingRow.outcome, 'failed');
assert.equal(failureTimingRow.valid, true);
assert.equal(failureTimingRow.complete, false);
assert.equal(failureTimingRow.phases.compile.state, 'measured');
assert.equal(failureTimingRow.phases.compile.durationNs, '3000000');
assert.equal(failureTimingRow.phases.compile.durationMs, 3);

for (const [outcome, visualCapable] of [
  ['refused', false],
  ['failed', true],
]) {
  const clock = controlledClock(40_000_000n);
  const recorder = new GpuHmrTestTimingRecorder({ clock: clock.now });
  clock.tick(1_000_000n);
  const totalOnly = recorder.finalize({
    outcome,
    visualCapable,
    terminalReason: `timing_smoke_total_only_${outcome}`,
    notApplicableReason: visualCapable ? null : 'timing_smoke_not_applicable',
  });
  const result = summaryRows(totalOnly, `timing-v2-total-only-${outcome}`);
  assert.equal(result.classified.length, 1);
  assert.equal(hasMeaningfulMetrics(
    result.classified[0].metrics,
    result.classified[0].kind,
  ), true);
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.rows[0].outcome, outcome);
  assert.equal(result.rows[0].totalWallMs, 1);
}

for (const alias of ['testTiming', 'test_timing', 'timingV2', 'timing_v2']) {
  const aliasSummary = summaryRows(
    { generic: { nested: { [alias]: computePass } } },
    `timing-v2-alias-${alias}`,
  );
  assert.equal(aliasSummary.classified.length, 1);
  assert.equal(aliasSummary.classified[0].recordAlias, alias);
  assert.equal(aliasSummary.rows[0].recordPath, `$.generic.nested.${alias}`);
}

const repeatedLogicalRecord = summaryRows({
  testTiming: computePass,
  test_timing: JSON.parse(JSON.stringify(computePass)),
  runtimeProofArtifact: {
    testTiming: reverseObjectKeyOrder(computePass),
    test_timing: JSON.parse(JSON.stringify(computePass)),
  },
}, 'timing-v2-repeated-logical-record');
assert.equal(repeatedLogicalRecord.classified.length, 1);
assert.match(repeatedLogicalRecord.classified[0].recordIdentity, /^sha256:[a-f0-9]{64}$/);
assert.equal(
  repeatedLogicalRecord.rows[0].recordIdentity,
  repeatedLogicalRecord.classified[0].recordIdentity,
);

const sameSummaryClock = controlledClock(50_000_000n);
const sameSummaryRecorder = new GpuHmrTestTimingRecorder({ clock: sameSummaryClock.now });
sameSummaryClock.tick(7_000_000n);
const sameSummaryDistinctRecord = sameSummaryRecorder.finalize({
  outcome: 'pass',
  visualCapable: false,
  terminalReason: 'timing_smoke_unavailable',
  notApplicableReason: 'timing_smoke_not_applicable',
});
const sameLookingDistinctRecords = summaryRows({
  testTiming: computePass,
  nested: { test_timing: sameSummaryDistinctRecord },
}, 'timing-v2-same-looking-distinct-records');
assert.equal(sameLookingDistinctRecords.classified.length, 2);
assert.deepEqual(
  sameLookingDistinctRecords.rows.map((row) => row.totalWallMs),
  [7, 7],
);
assert.equal(
  new Set(sameLookingDistinctRecords.rows.map((row) => row.recordIdentity)).size,
  2,
);

const repeatedAcrossRetainedArtifacts = deduplicateGpuHmrTestTimingV2Rows([
  {
    ...repeatedLogicalRecord.classified[0],
    filePath: path.join(process.cwd(), 'tmp', 'retained-report.json'),
  },
  {
    ...repeatedLogicalRecord.classified[0],
    recordPath: '$.summary.test_timing',
    filePath: path.join(process.cwd(), 'tmp', 'retained-summary.json'),
  },
  ...sameLookingDistinctRecords.classified,
]);
assert.equal(repeatedAcrossRetainedArtifacts.length, 2);
assert.equal(
  new Set(repeatedAcrossRetainedArtifacts.map((row) => row.recordIdentity)).size,
  2,
);

const additiveSummary = summaryRows({
  timingMetrics: external,
  generic: { testTiming: visualPass },
}, 'timing-v1-v2-additive');
assert.equal(additiveSummary.classified.length, 2);
const retainedV1 = additiveSummary.rows.find((row) => row.source === external.source);
assert.equal(retainedV1.totalWallMs, external.totalWallMs);
assert.equal(retainedV1.metricClock, external.metricClock);
assert.equal(
  additiveSummary.rows.find((row) => row.source === 'gpu_hmr_test_timing_v2').outcome,
  'pass',
);

const authorityForgery = JSON.parse(JSON.stringify(visualPass));
authorityForgery.authority = 'gpu_hmr_success_authority';
authorityForgery.acceptedForGpuHmr = true;
authorityForgery.gpuHmrSuccess = true;
authorityForgery.success = true;
authorityForgery.hiprt_runtime_probe = {};
const forgedSummary = summaryRows(authorityForgery, 'timing-v2-forged-authority');
const forgedTimingRow = forgedSummary.rows[0];
assert.equal(forgedSummary.classified.length, 1);
assert.equal(forgedSummary.classified[0].kind, 'gpu_hmr_test_timing_v2');
assert.equal(forgedTimingRow.valid, false);
assert.equal(forgedTimingRow.complete, false);
assert.ok(forgedTimingRow.validationGaps.includes('timing_authority_invalid'));
assert.ok(forgedTimingRow.validationGaps.includes('accepted_for_gpu_hmr_must_be_false'));
assert.ok(forgedTimingRow.validationGaps.includes('gpu_hmr_success_must_be_false'));
assert.equal(forgedTimingRow.acceptedForGpuHmr, false);
assert.equal(forgedTimingRow.gpuHmrSuccess, false);
assert.equal(forgedTimingRow.evidenceAuthority, GPU_HMR_TIMING_TELEMETRY_AUTHORITY);
assert.equal(forgedTimingRow.proofVerdict, 'not_evaluated_by_timing_summary');
assert.equal(Object.hasOwn(forgedTimingRow, 'status'), false);

for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
  assert.ok(Object.hasOwn(failureTimingRow.phases, phaseKey));
  assert.ok(Object.hasOwn(failureTimingRow.phases[phaseKey], 'state'));
  assert.ok(Object.hasOwn(failureTimingRow.phases[phaseKey], 'durationNs'));
  assert.ok(Object.hasOwn(failureTimingRow.phases[phaseKey], 'durationMs'));
}
for (const phaseKey of [
  'trigger_to_visible',
  'screenshot_capture',
  'visual_analysis',
  'proof_finalization',
  'total_wall',
]) {
  assert.ok(Object.hasOwn(failureTimingRow.phases, phaseKey));
}
assert.equal(
  failureTimingRow.triggerToVisibleMs,
  failureTimingRow.phases.trigger_to_visible.durationMs,
);
assert.equal(
  failureTimingRow.screenshotCaptureMs,
  failureTimingRow.phases.screenshot_capture.durationMs,
);
assert.equal(failureTimingRow.visualAnalysisMs, failureTimingRow.phases.visual_analysis.durationMs);
assert.equal(
  failureTimingRow.proofFinalizationMs,
  failureTimingRow.phases.proof_finalization.durationMs,
);
assert.equal(failureTimingRow.totalWallMs, failureTimingRow.phases.total_wall.durationMs);

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
  checkedProfiles: [external.profileId, hiprt.profileId, rocm.profileId, webgpu.profileId, webgpuCompute.profileId],
  checkedTimingCoreCases: [
    'valid_trusted_v3_integration',
    'immutable_trusted_v3_tuple',
    'generic_trusted_v3_entry_point',
    'compute_first_output_ready_distinct_from_output_ready_phase',
    'content_subject_replay_source_edit_artifact_ledger_report_rejected',
    'semantic_project_backend_capability_labels_diagnostic_only',
    'named_wrapper_labels_do_not_change_validity',
    'oversized_257_screenshot_diagnostics_do_not_affect_trusted_metrics',
    'oversized_diagnostic_strings_objects_unavailable_only',
    'report_modality_binding_mismatch_rejected',
    'caller_selector_options_have_no_authority',
    'report_binding_omission_rejected',
    'caller_expected_binding_has_no_authority',
    'validated_persistence_receipt_and_replay_rejection',
    'forged_self_consistent_recorder_rejected',
    'caller_supplied_record_untrusted',
    'raw_manifest_options_untrusted',
    'v3_manifest_mismatch',
    'wall_vs_monotonic_mixing',
    'missing_endpoint',
    'reversed_endpoint',
    'duration_overflow_rejected',
    'forged_domain',
    'nested_getters_rejected_without_execution',
    'nested_proxies_rejected_without_traps',
    'receipt_and_validation_option_traps_rejected',
    'deep_dag_bounded',
    'structural_cycle_rejected',
    'identifier_containing_cyclic_valid',
    'endpoint_free_visual_scalars_unavailable',
    'conflicting_legacy_and_proof_aliases_rejected',
    'measured_zero_distinct_from_unavailable',
    'outcome_alias_conflicts_refused',
    'numeric_coercion_rejection',
    'canonical_numeric_string',
    'telemetry_only_authority',
  ],
  checkedV2Cases: [
    'visual_pass',
    'compute_pass',
    'refusal_before_compile',
    'thrown_failure_partial_phase',
    'nested_aliases',
    'logical_record_deduplication',
    'same_summary_distinct_records',
    'retained_copy_deduplication',
    'forged_authority',
  ],
}, null, 2));
