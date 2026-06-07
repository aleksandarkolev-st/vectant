#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  externalProjectTimingMetrics,
  hiprtWarmTimingMetrics,
  realRocmTimingMetrics,
  GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
} from '../lib/gpu-hmr-timing-metrics.mjs';

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
  assert.equal(typeof metrics.normalizedTimings, 'object');
  assert.equal(typeof metrics.normalized_timings, 'object');
  assert.equal(typeof metrics.clockEvidence, 'object');
  assert.equal(metrics.metricUnit, 'ms');
  assert.equal(metrics.metric_unit, 'ms');
  for (const key of NORMALIZED_KEYS) {
    assert.ok(Object.prototype.hasOwnProperty.call(metrics.normalizedTimings, key), `missing normalized key ${key}`);
  }
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
      model_availability_check_time: 3,
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

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
  checkedProfiles: [external.profileId, hiprt.profileId, rocm.profileId],
}, null, 2));
