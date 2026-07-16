#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  externalProjectTimingMetrics,
  hiprtWarmTimingMetrics,
  realRocmTimingMetrics,
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
  'setupBuildMs',
  'adapterBuildMs',
  'runtimeReadyMs',
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

const external = externalProjectTimingMetrics({
  profile: { id: 'threejs-webgl-shader-lava', project: { name: 'Three.js' } },
  proofMode: 'external_runtime_screenshot',
  status: 'pass',
  timings: {
    metric_clock: 'monotonic_ns',
    started_monotonic_ns: '1000000000',
    finished_monotonic_ns: '1600000000',
    duration_monotonic_ns: '600000000',
    buildMs: 100,
    runtimeReadyMs: 20,
    sourceWriteMs: 3,
    afterCompileWallMs: 45,
    editToRuntimeSignalMs: 50,
    editToScreenshotMs: 400,
    visualDiffMs: 7,
    runtimeStopMs: 9,
    totalMs: 600,
  },
  mcp: {
    modelProvenance: {
      expectedSplitModel: 'gemini-3.5-flash',
      expectedDeltaModel: 'gemini-3.1-flash-lite',
      modelAvailabilityCheckMs: 2,
    },
  },
  screenshots: [
    { label: 'before', elapsedMs: 111 },
    { label: 'after', elapsedMs: 222 },
  ],
  visualDiff: { changedPixelRatio: 0.25, meanAbsDelta8bit: 12 },
});
assertCommonShape(external);
assert.equal(external.hotReloadSignalMs, 50);
assert.equal(external.beforeCaptureMs, 111);
assert.equal(external.modelAvailabilityCheckMs, 2);
assert.equal(external.modelProvenance.expectedDeltaModel, 'gemini-3.1-flash-lite');
assert.equal(external.metricClock, 'monotonic_ns');
assert.equal(external.clockEvidence.durationMonotonicMs, 600);
assert.equal(external.normalizedTimings.deviceCompileWallTimeMs, 45);
assert.equal(external.normalizedTimings.screenshotCaptureTimeMs, 333);
assert.equal(external.normalizedTimings.totalValidatorWallTimeMs, 600);

const hiprt = hiprtWarmTimingMetrics({
  accepted: true,
  mode: 'same-process',
  profile: { id: 'hiprt-megakernel-direct-light-zero' },
  repo: { target: 'HIPRTPathTracer' },
  timings: {
    metric_clock: 'monotonic_ns',
    started_monotonic_ns: '2000000000',
    finished_monotonic_ns: '3000000000',
    duration_monotonic_ns: '1000000000',
    totalWallMs: 1000,
    sameProcessAdapterBuildMs: 300,
    sameProcessLiveRecompileMs: 31,
    sameProcessTriggerWaitMs: 2,
    baselineHostWallMs: 100,
    changedHostWallMs: 120,
  },
  sourceWrites: {
    baseline: { hostWallMs: 4 },
    changed: { hostWallMs: 5 },
    restoredBaseline: { hostWallMs: 6 },
  },
  runtime: {
    baseline: { hostWallMs: 100 },
    changed: { hostWallMs: 120, triggerTouchMs: 1, totalHostWallMs: 180 },
  },
  modelProvenance: {
    split: {
      requested_model: 'gemini-3.5-flash',
      provider_model_status: 'available',
      model_availability_source: 'https://ai.google.dev/gemini-api/docs/deprecations',
      model_availability_basis: 'static_registry',
      model_availability_check_time_ms: 3,
    },
  },
  diff: { changedPixelRatioThreshold4: 0.4, meanAbsDelta8bit: 30 },
});
assertCommonShape(hiprt);
assert.equal(hiprt.sourceWriteMs, 15);
assert.equal(hiprt.sameProcessLiveRecompileMs, 31);
assert.equal(hiprt.modelAvailabilityCheckMs, 3);
assert.equal(hiprt.normalizedTimings.deviceCompileWallTimeMs, 31);
assert.equal(hiprt.normalizedTimings.adapterGenerationTimeMs, 300);
assert.equal(hiprt.normalizedTimings.totalValidatorWallTimeMs, 1000);

const rocm = realRocmTimingMetrics({
  slug: 'rocm-saxpy',
  target_name: 'saxpy',
  metric_clock: 'monotonic_ns',
  started_monotonic_ns: '4000000000',
  finished_monotonic_ns: '6000000000',
  duration_monotonic_ns: '2000000000',
  duration_ms: 2000,
  phases: [
    { name: 'upstream_gpu_build_run', timings: 'configure_ms=10\nbuild_ms=20\nrun_ms=30\n' },
    { name: 'first split/HMR', compile_wall_ms: 400, wait_hmr_elapsed_ms: 50, wait_call_wall_ms: 55 },
    { name: 'gpu delta HMR', compile_wall_ms: 40, wait_hmr_elapsed_ms: 8, wait_call_wall_ms: 10 },
  ],
  evidence: {
    ai_call_counts: { gpu_delta: 1 },
    ai_model_provenance: {
      gpu_delta: {
        requested_model: 'gemini-3.1-flash-lite',
        provider_model_status: 'deprecated',
        model_availability_source: 'https://ai.google.dev/gemini-api/docs/deprecations',
        model_availability_basis: 'static_registry',
        modelAvailabilityCheckTimeMs: 4,
      },
    },
  },
  screenshots: [{ accepted_as_visual_evidence: true }],
});
assertCommonShape(rocm);
assert.equal(rocm.setupBuildMs, 30);
assert.equal(rocm.hotHmrCompileWallMs, 40);
assert.equal(rocm.aiDeltaWallMs, 40);
assert.equal(rocm.modelAvailabilityCheckMs, 4);
assert.equal(rocm.normalizedTimings.deviceCompileWallTimeMs, 40);
assert.equal(rocm.normalizedTimings.runtimeProbeTimeMs, 30);
assert.equal(rocm.normalizedTimings.totalValidatorWallTimeMs, 2000);

const blockedRocm = realRocmTimingMetrics({
  slug: 'rocm-large-blocked',
  target_name: 'large-rocm-driver',
  metric_clock: 'monotonic_ns',
  started_monotonic_ns: '7000000000',
  finished_monotonic_ns: '9000000000',
  duration_monotonic_ns: '2000000000',
  duration_ms: 2000,
  phases: [
    { name: 'upstream_gpu_build_run', timings: 'configure_ms=10\nbuild_ms=20\nrun_ms=30\n' },
    { name: 'first split/HMR', compile_wall_ms: 400, wait_hmr_elapsed_ms: 50, wait_call_wall_ms: 55 },
    {
      name: 'real_repo_user_source_delta_hmr',
      compile_wall_ms: 40,
      wait_hmr_elapsed_ms: 30000,
      wait_call_wall_ms: 30010,
      proof_scheduling: {
        schemaVersion: 'synthi.gpu_hmr.real_rocm_proof_scheduling.v1',
        accepted_as_refusal_evidence: true,
        fast_fail_applied: true,
      },
    },
  ],
  evidence: {
    ai_call_counts: { gpu_delta: 1 },
  },
});
assertCommonShape(blockedRocm);
assert.equal(blockedRocm.hotReloadSignalMs, null);
assert.equal(blockedRocm.blockedValidationWaitMs, 30010);
assert.equal(blockedRocm.blocked_validation_wait_ms, 30010);
assert.equal(blockedRocm.normalizedTimings.triggerToVisibleTimeMs, null);
assert.equal(
  blockedRocm.phases.find((entry) => entry.name === 'blocked_validation_wait')?.wallMs,
  30010,
);

const webgpu = webGpuRuntimeVisualTimingMetrics({
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:test',
  gpuHmrSuccess: true,
  profile: { id: 'webgpu-wgsl-runtime-triangle' },
  metrics: {
    changedPixelRatio: 0.29,
    meanAbsDelta8bit: 37,
    visiblePixelCount: 67713,
  },
  timings: {
    static_discovery_time: 1_000_000,
    ai_contract_synthesis_time: 0,
    model_availability_check_time: 1_000_000,
    artifact_hash_time: 2_000_000,
    adapter_generation_time: 50_000_000,
    device_compile_wall_time: 15_000_000,
    artifact_load_time: 100_000,
    epoch_publish_time: 100_000,
    dispatch_trace_time: 14_800_000,
    runtime_probe_time: 300_000_000,
    oracle_analysis_time: 10_000_000,
    trigger_to_visible_time: 67_000_000,
    screenshot_capture_time: 40_000_000,
    dispatch_to_output_proof_time: 55_000_000,
    total_validator_wall_time: 951_000_000,
  },
  proofLedger: {
    records: [{
      metricScope: 'hot_delta_1',
      cacheState: 'pipeline_cache_warm',
      modelProvenance: {
        split: { model_availability_check_time_ms: 1 },
      },
    }],
  },
});
assertCommonShape(webgpu);
assert.equal(webgpu.source, 'webgpu_runtime_visual');
assert.equal(webgpu.profileId, 'webgpu-wgsl-runtime-triangle');
assert.equal(webgpu.status, 'pass');
assert.equal(webgpu.reportedStatus, 'pass');
assert.equal(webgpu.totalWallMs, 951);
assert.equal(webgpu.editToFirstVisualMs, 67);
assert.equal(webgpu.visualEvidence.changedPixelRatio, 0.29);
assert.equal(webgpu.normalizedTimings.dispatchTraceTimeMs, 14.8);

const webgpuCompute = webGpuRuntimeComputeTimingMetrics({
  schema: 'synthi.gpu_hmr.webgpu_runtime_compute_proof.v1',
  proofId: 'webgpu-runtime-compute-proof:sha256:test',
  gpuHmrSuccess: true,
  profile: { id: 'webgpu-wgsl-runtime-compute-storage' },
  computeOracleArtifacts: {
    raw_readback_hash: 'sha256:' + 'd'.repeat(64),
    raw_readback_byte_length: 32,
    deterministic_slice_hash: 'sha256:' + 'e'.repeat(64),
    rendered_card_png: 'mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/card.png',
  },
  timings: {
    static_discovery_time: 1_000_000,
    ai_contract_synthesis_time: 0,
    model_availability_check_time: 1_000_000,
    artifact_hash_time: 2_000_000,
    adapter_generation_time: 50_000_000,
    device_compile_wall_time: 15_000_000,
    artifact_load_time: 100_000,
    epoch_publish_time: 100_000,
    dispatch_trace_time: 14_800_000,
    runtime_probe_time: 300_000_000,
    oracle_analysis_time: 10_000_000,
    trigger_to_visible_time: 67_000_000,
    screenshot_capture_time: 0,
    dispatch_to_output_proof_time: 55_000_000,
    total_validator_wall_time: 951_000_000,
  },
  proofLedger: {
    records: [{
      metricScope: 'hot_delta_1',
      cacheState: 'pipeline_cache_warm',
      modelProvenance: {
        split: { model_availability_check_time_ms: 1 },
      },
    }],
  },
});
assertCommonShape(webgpuCompute);
assert.equal(webgpuCompute.source, 'webgpu_runtime_compute');
assert.equal(webgpuCompute.profileId, 'webgpu-wgsl-runtime-compute-storage');
assert.equal(webgpuCompute.status, 'pass');
assert.equal(webgpuCompute.reportedStatus, 'pass');
assert.equal(webgpuCompute.totalWallMs, 951);
assert.equal(webgpuCompute.computeEvidence.rawReadbackByteLength, 32);
assert.equal(webgpuCompute.computeEvidence.computeCardAccepted, true);
assert.equal(webgpuCompute.computeEvidence.reportedAccepted, true);
assert.equal(webgpuCompute.visualEvidence.screenshotCount, 0);
assert.equal(webgpuCompute.visualEvidence.accepted, false);
assert.equal(webgpuCompute.visualEvidence.reportedAccepted, false);
assert.equal(
  webgpuCompute.visualEvidence.reason,
  'webgpu_compute_readback_uses_compute_card_not_runtime_frame_visual_proof',
);
assert.equal(webgpuCompute.editToFirstVisualMs, null);
assert.equal(webgpuCompute.normalizedTimings.dispatchToOutputProofTimeMs, 55);

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
