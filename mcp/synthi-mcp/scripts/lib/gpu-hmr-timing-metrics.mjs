export const GPU_HMR_TIMING_METRICS_SCHEMA_VERSION = 'synthi.gpu.hmr.timing_metrics.v1';

function finiteMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finiteNsString(value) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const ns = BigInt(String(value));
    return ns >= 0n ? ns.toString() : null;
  } catch {
    return null;
  }
}

function nsToMs(value) {
  const ns = finiteNsString(value);
  return ns === null ? null : Number(BigInt(ns)) / 1_000_000;
}

function sumMs(values) {
  let total = 0;
  let seen = false;
  for (const value of values) {
    const ms = finiteMs(value);
    if (ms === null) continue;
    total += ms;
    seen = true;
  }
  return seen ? total : null;
}

function maxMs(values) {
  const finite = values.map(finiteMs).filter((value) => value !== null);
  return finite.length > 0 ? Math.max(...finite) : null;
}

function phase(name, wallMs, source = null) {
  return {
    name,
    wallMs: finiteMs(wallMs),
    source,
  };
}

function firstObject(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return null;
}

function modelAvailabilityCheckMs(modelProvenance) {
  const direct = finiteMs(modelProvenance?.modelAvailabilityCheckMs)
    ?? finiteMs(modelProvenance?.model_availability_check_time)
    ?? finiteMs(modelProvenance?.model_availability_check_time_ms)
    ?? finiteMs(modelProvenance?.modelAvailabilityCheckTimeMs);
  if (direct !== null) return direct;
  const nested = firstObject(
    modelProvenance?.split,
    modelProvenance?.gpu_split,
    modelProvenance?.last_gpu_delta,
    modelProvenance?.gpu_delta,
  );
  return nested ? modelAvailabilityCheckMs(nested) : null;
}

function screenshotElapsedMs(screenshots, label) {
  const shot = Array.isArray(screenshots)
    ? screenshots.find((item) => item?.label === label)
    : null;
  return finiteMs(shot?.elapsedMs);
}

function metricClock(report, timings) {
  const explicit = report?.metricClock
    ?? report?.metric_clock
    ?? timings?.metricClock
    ?? timings?.metric_clock;
  if (explicit) return explicit;
  return monotonicDurationNs(report, timings) !== null ? 'monotonic_ns' : 'wall_ms';
}

function metricScope(report, fallback) {
  return report?.metricScope ?? report?.metric_scope ?? fallback;
}

function cacheState(report) {
  const explicit = report?.cacheState ?? report?.cache_state;
  if (explicit && explicit !== 'unknown') return explicit;
  const upstreamPhase = Array.isArray(report?.phases)
    ? report.phases.find((item) => item?.name === 'upstream_gpu_build_run')
    : null;
  if (upstreamPhase?.clean_build === true) return 'clean';
  if (
    report?.worker_repo_reuse?.reused === true
    || report?.worker_repo_reuse?.requested === true
    || upstreamPhase?.clean_build === false
  ) {
    return 'compiler_cache_warm';
  }
  return explicit ?? 'unknown';
}

function monotonicDurationNs(report, timings) {
  return finiteNsString(
    report?.durationMonotonicNs
    ?? report?.duration_monotonic_ns
    ?? timings?.durationMonotonicNs
    ?? timings?.duration_monotonic_ns,
  );
}

function monotonicStartNs(report, timings) {
  return finiteNsString(
    report?.startedMonotonicNs
    ?? report?.started_monotonic_ns
    ?? timings?.startedMonotonicNs
    ?? timings?.started_monotonic_ns,
  );
}

function monotonicFinishedNs(report, timings) {
  return finiteNsString(
    report?.finishedMonotonicNs
    ?? report?.finished_monotonic_ns
    ?? timings?.finishedMonotonicNs
    ?? timings?.finished_monotonic_ns,
  );
}

function timingClockEvidence(report, timings) {
  const durationNs = monotonicDurationNs(report, timings);
  return {
    metric_clock: metricClock(report, timings),
    metricClock: metricClock(report, timings),
    metric_unit: 'ms',
    metricUnit: 'ms',
    started_monotonic_ns: monotonicStartNs(report, timings),
    startedMonotonicNs: monotonicStartNs(report, timings),
    finished_monotonic_ns: monotonicFinishedNs(report, timings),
    finishedMonotonicNs: monotonicFinishedNs(report, timings),
    duration_monotonic_ns: durationNs,
    durationMonotonicNs: durationNs,
    duration_monotonic_ms: nsToMs(durationNs),
    durationMonotonicMs: nsToMs(durationNs),
  };
}

function normalizedTimingFields(fields) {
  const normalized = {
    staticDiscoveryTimeMs: finiteMs(fields.staticDiscoveryTimeMs),
    aiContractSynthesisTimeMs: finiteMs(fields.aiContractSynthesisTimeMs),
    modelAvailabilityCheckTimeMs: finiteMs(fields.modelAvailabilityCheckTimeMs),
    artifactHashTimeMs: finiteMs(fields.artifactHashTimeMs),
    adapterGenerationTimeMs: finiteMs(fields.adapterGenerationTimeMs),
    deviceCompileWallTimeMs: finiteMs(fields.deviceCompileWallTimeMs),
    artifactLoadTimeMs: finiteMs(fields.artifactLoadTimeMs),
    epochPublishTimeMs: finiteMs(fields.epochPublishTimeMs),
    dispatchTraceTimeMs: finiteMs(fields.dispatchTraceTimeMs),
    runtimeProbeTimeMs: finiteMs(fields.runtimeProbeTimeMs),
    oracleAnalysisTimeMs: finiteMs(fields.oracleAnalysisTimeMs),
    triggerToVisibleTimeMs: finiteMs(fields.triggerToVisibleTimeMs),
    screenshotCaptureTimeMs: finiteMs(fields.screenshotCaptureTimeMs),
    dispatchToOutputProofTimeMs: finiteMs(fields.dispatchToOutputProofTimeMs),
    totalValidatorWallTimeMs: finiteMs(fields.totalValidatorWallTimeMs),
  };
  return {
    ...normalized,
    snake_case: {
      static_discovery_time: normalized.staticDiscoveryTimeMs,
      ai_contract_synthesis_time: normalized.aiContractSynthesisTimeMs,
      model_availability_check_time: normalized.modelAvailabilityCheckTimeMs,
      artifact_hash_time: normalized.artifactHashTimeMs,
      adapter_generation_time: normalized.adapterGenerationTimeMs,
      device_compile_wall_time: normalized.deviceCompileWallTimeMs,
      artifact_load_time: normalized.artifactLoadTimeMs,
      epoch_publish_time: normalized.epochPublishTimeMs,
      dispatch_trace_time: normalized.dispatchTraceTimeMs,
      runtime_probe_time: normalized.runtimeProbeTimeMs,
      oracle_analysis_time: normalized.oracleAnalysisTimeMs,
      trigger_to_visible_time: normalized.triggerToVisibleTimeMs,
      screenshot_capture_time: normalized.screenshotCaptureTimeMs,
      dispatch_to_output_proof_time: normalized.dispatchToOutputProofTimeMs,
      total_validator_wall_time: normalized.totalValidatorWallTimeMs,
    },
  };
}

export function externalProjectTimingMetrics(report) {
  const timings = report?.timings ?? {};
  const clockEvidence = timingClockEvidence(report, timings);
  const screenshots = Array.isArray(report?.screenshots) ? report.screenshots : [];
  const beforeCaptureMs = screenshotElapsedMs(screenshots, 'before');
  const afterCaptureMs = screenshotElapsedMs(screenshots, 'after');
  const hmrCompileWallMs = finiteMs(timings.editToMcpHmrMs)
    ?? finiteMs(timings.afterCompileWallMs);
  const hotReloadSignalMs = finiteMs(timings.editToRuntimeSignalMs)
    ?? finiteMs(timings.editToMcpHmrMs);
  const editToFirstVisualMs = finiteMs(timings.editToScreenshotMs);
  const modelProvenance = firstObject(
    report?.modelProvenance,
    report?.model_provenance,
    report?.mcp?.modelProvenance,
    report?.mcp?.model_provenance,
  );
  const modelAvailability = modelAvailabilityCheckMs(modelProvenance);
  const normalizedTimings = normalizedTimingFields({
    modelAvailabilityCheckTimeMs: modelAvailability,
    adapterGenerationTimeMs: null,
    deviceCompileWallTimeMs: hmrCompileWallMs,
    runtimeProbeTimeMs: timings.runtimeReadyMs,
    oracleAnalysisTimeMs: timings.visualDiffMs,
    triggerToVisibleTimeMs: editToFirstVisualMs,
    screenshotCaptureTimeMs: sumMs([beforeCaptureMs, afterCaptureMs]),
    totalValidatorWallTimeMs: clockEvidence.durationMonotonicMs ?? timings.totalMs,
  });

  return {
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    source: 'external_project_profile',
    metricClock: clockEvidence.metricClock,
    metric_clock: clockEvidence.metric_clock,
    metricUnit: clockEvidence.metricUnit,
    metric_unit: clockEvidence.metric_unit,
    metricScope: metricScope(report, 'hot_delta_1'),
    metric_scope: metricScope(report, 'hot_delta_1'),
    cacheState: cacheState(report),
    cache_state: cacheState(report),
    profileId: report?.profile?.id ?? null,
    projectName: report?.profile?.project?.name ?? null,
    proofMode: report?.proofMode ?? null,
    status: report?.status ?? null,
    totalWallMs: clockEvidence.durationMonotonicMs ?? finiteMs(timings.totalMs),
    setupBuildMs: finiteMs(timings.buildMs),
    adapterBuildMs: null,
    runtimeReadyMs: finiteMs(timings.runtimeReadyMs),
    initialCompileWallMs: finiteMs(timings.beforeCompileWallMs),
    sourceWriteMs: finiteMs(timings.sourceWriteMs),
    modelAvailabilityCheckMs: modelAvailability,
    modelProvenance,
    aiDeltaWallMs: report?.mcp?.modelProvenance?.expectedDeltaModel
      ? hmrCompileWallMs
      : null,
    hotHmrCompileWallMs: hmrCompileWallMs,
    sameProcessLiveRecompileMs: null,
    sameProcessTriggerWaitMs: null,
    hotReloadSignalMs,
    editToFirstVisualMs,
    beforeCaptureMs,
    afterCaptureMs,
    visualDiffMs: finiteMs(timings.visualDiffMs),
    teardownMs: finiteMs(timings.runtimeStopMs),
    normalizedTimings,
    normalized_timings: normalizedTimings.snake_case,
    clockEvidence,
    clock_evidence: clockEvidence,
    visualEvidence: {
      screenshotCount: screenshots.length,
      changedPixelRatio: finiteMs(report?.visualDiff?.changedPixelRatio),
      meanAbsDelta8bit: finiteMs(report?.visualDiff?.meanAbsDelta8bit),
      accepted: report?.status === 'pass',
    },
    phases: [
      phase('setup_build', timings.buildMs, 'timings.buildMs'),
      phase('runtime_ready', timings.runtimeReadyMs, 'timings.runtimeReadyMs'),
      phase('initial_compile', timings.beforeCompileWallMs, 'timings.beforeCompileWallMs'),
      phase('source_write', timings.sourceWriteMs, 'timings.sourceWriteMs'),
      phase('hot_hmr_compile', hmrCompileWallMs, 'timings.editToMcpHmrMs|timings.afterCompileWallMs'),
      phase('hot_reload_signal', hotReloadSignalMs, 'timings.editToRuntimeSignalMs|timings.editToMcpHmrMs'),
      phase('before_capture', beforeCaptureMs, 'screenshots.before.elapsedMs'),
      phase('after_capture', afterCaptureMs, 'screenshots.after.elapsedMs'),
      phase('edit_to_first_visual', editToFirstVisualMs, 'timings.editToScreenshotMs'),
      phase('visual_diff', timings.visualDiffMs, 'timings.visualDiffMs'),
      phase('teardown', timings.runtimeStopMs, 'timings.runtimeStopMs'),
    ],
  };
}

export function hiprtWarmTimingMetrics(proof) {
  const timings = proof?.timings ?? {};
  const clockEvidence = timingClockEvidence(proof, timings);
  const sourceWrites = proof?.sourceWrites ?? {};
  const changedRun = proof?.runtime?.changed ?? {};
  const baselineRun = proof?.runtime?.baseline ?? {};
  const sourceWriteMs = sumMs([
    sourceWrites.baseline?.hostWallMs,
    sourceWrites.changed?.hostWallMs,
    sourceWrites.restoredBaseline?.hostWallMs,
  ]);
  const beforeCaptureMs = finiteMs(baselineRun.hostWallMs)
    ?? finiteMs(timings.baselineHostWallMs)
    ?? finiteMs(timings.baselineRunMs);
  const afterCaptureMs = finiteMs(changedRun.hostWallMs)
    ?? finiteMs(timings.changedHostWallMs)
    ?? finiteMs(timings.changedRunMs);
  const modelProvenance = firstObject(
    proof?.modelProvenance,
    proof?.model_provenance,
    proof?.runtime?.modelProvenance,
    proof?.runtime?.model_provenance,
  );
  const modelAvailability = modelAvailabilityCheckMs(modelProvenance);
  const normalizedTimings = normalizedTimingFields({
    modelAvailabilityCheckTimeMs: modelAvailability,
    adapterGenerationTimeMs: timings.sameProcessAdapterBuildMs,
    deviceCompileWallTimeMs: timings.sameProcessLiveRecompileMs,
    runtimeProbeTimeMs: beforeCaptureMs,
    oracleAnalysisTimeMs: null,
    triggerToVisibleTimeMs: changedRun.totalHostWallMs
      ?? timings.changedHostWallMs
      ?? timings.changedRunMs,
    screenshotCaptureTimeMs: sumMs([beforeCaptureMs, afterCaptureMs]),
    totalValidatorWallTimeMs: clockEvidence.durationMonotonicMs ?? timings.totalWallMs,
  });

  return {
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    source: 'hiprt_warm_runtime',
    metricClock: clockEvidence.metricClock,
    metric_clock: clockEvidence.metric_clock,
    metricUnit: clockEvidence.metricUnit,
    metric_unit: clockEvidence.metric_unit,
    metricScope: metricScope(proof, 'hot_delta_1'),
    metric_scope: metricScope(proof, 'hot_delta_1'),
    cacheState: cacheState(proof),
    cache_state: cacheState(proof),
    profileId: proof?.profile?.id ?? proof?.runtimeProfile?.id ?? null,
    projectName: proof?.repo?.target ?? null,
    proofMode: timings.mode ?? proof?.mode ?? null,
    status: proof?.accepted === true ? 'pass' : 'fail',
    totalWallMs: clockEvidence.durationMonotonicMs ?? finiteMs(timings.totalWallMs),
    setupBuildMs: finiteMs(timings.sameProcessAdapterBuildMs),
    adapterBuildMs: finiteMs(timings.sameProcessAdapterBuildMs),
    runtimeReadyMs: beforeCaptureMs,
    initialCompileWallMs: null,
    sourceWriteMs,
    modelAvailabilityCheckMs: modelAvailability,
    modelProvenance,
    aiDeltaWallMs: null,
    hotHmrCompileWallMs: finiteMs(timings.sameProcessLiveRecompileMs),
    sameProcessLiveRecompileMs: finiteMs(timings.sameProcessLiveRecompileMs),
    sameProcessTriggerWaitMs: finiteMs(timings.sameProcessTriggerWaitMs),
    hotReloadSignalMs: finiteMs(changedRun.triggerTouchMs)
      ?? finiteMs(timings.sameProcessTriggerWaitMs),
    editToFirstVisualMs: finiteMs(changedRun.totalHostWallMs)
      ?? finiteMs(timings.changedHostWallMs)
      ?? finiteMs(timings.changedRunMs),
    beforeCaptureMs,
    afterCaptureMs,
    visualDiffMs: null,
    teardownMs: null,
    normalizedTimings,
    normalized_timings: normalizedTimings.snake_case,
    clockEvidence,
    clock_evidence: clockEvidence,
    visualEvidence: {
      screenshotCount: 2,
      changedPixelRatio: finiteMs(proof?.diff?.changedPixelRatioThreshold4),
      meanAbsDelta8bit: finiteMs(proof?.diff?.meanAbsDelta8bit),
      accepted: proof?.accepted === true,
    },
    phases: [
      phase('adapter_build', timings.sameProcessAdapterBuildMs, 'timings.sameProcessAdapterBuildMs'),
      phase('baseline_capture', beforeCaptureMs, 'runtime.baseline.hostWallMs|timings.baselineHostWallMs'),
      phase('source_write', sourceWriteMs, 'sourceWrites.*.hostWallMs'),
      phase('trigger_wait', timings.sameProcessTriggerWaitMs, 'timings.sameProcessTriggerWaitMs'),
      phase('live_recompile', timings.sameProcessLiveRecompileMs, 'timings.sameProcessLiveRecompileMs'),
      phase('changed_capture', afterCaptureMs, 'runtime.changed.hostWallMs|timings.changedHostWallMs'),
      phase('edit_to_first_visual', changedRun.totalHostWallMs ?? timings.changedHostWallMs, 'runtime.changed.totalHostWallMs|timings.changedHostWallMs'),
    ],
  };
}

function keyValueTiming(text, key) {
  if (typeof text !== 'string') return null;
  const match = new RegExp(`\\b${key}=([^\\s]+)`).exec(text);
  return finiteMs(match?.[1]);
}

function realRocmStatus(report) {
  if (report?.accepted === true || report?.failed === false || report?.status === 'pass') {
    return 'pass';
  }
  if (report?.failed === true || report?.status === 'fail') {
    return 'fail';
  }

  const strictGates = Array.isArray(report?.strict_proof_gates)
    ? report.strict_proof_gates
    : [];
  if (strictGates.length > 0 && strictGates.every((gate) => gate?.status === 'pass')) {
    return 'pass';
  }
  if (strictGates.some((gate) => gate?.status === 'fail')) {
    return 'fail';
  }

  return null;
}

export function realRocmTimingMetrics(report) {
  const reportTimings = report?.timings ?? {};
  const clockEvidence = timingClockEvidence(report, reportTimings);
  const phases = Array.isArray(report?.phases) ? report.phases : [];
  const upstream = phases.find((item) => item?.name === 'upstream_gpu_build_run');
  const firstCompile = phases.find((item) => item?.name === 'first split/HMR');
  const deltaCompile = phases.find((item) => /delta|second|hot/i.test(String(item?.name ?? '')));
  const screenshotPhases = Array.isArray(report?.screenshots) ? report.screenshots : [];
  const compileWalls = phases.map((item) => finiteMs(item?.compile_wall_ms)).filter((value) => value !== null);
  const waitWalls = phases.map((item) => finiteMs(item?.wait_call_wall_ms)).filter((value) => value !== null);
  const modelProvenance = firstObject(
    report?.modelProvenance,
    report?.model_provenance,
    report?.evidence?.ai_model_provenance,
    report?.evidence?.model_provenance,
  );
  const modelAvailability = modelAvailabilityCheckMs(modelProvenance);
  const splitLatencyMs = finiteMs(modelProvenance?.split?.latency_ms)
    ?? finiteMs(modelProvenance?.gpu_split?.latency_ms);
  const setupBuildMs = sumMs([
    keyValueTiming(upstream?.timings, 'configure_ms'),
    keyValueTiming(upstream?.timings, 'build_ms'),
  ]);
  const hotCompileMs = finiteMs(deltaCompile?.compile_wall_ms) ?? maxMs(compileWalls.slice(1));
  const hotSignalMs = finiteMs(deltaCompile?.wait_hmr_elapsed_ms) ?? maxMs(waitWalls);
  const dispatchTimestamps = Array.isArray(report?.dispatch_proof?.dispatchTimestamps)
    ? report.dispatch_proof.dispatchTimestamps.map(finiteMs).filter((value) => value !== null)
    : [];
  const latestDispatchTimestamp = dispatchTimestamps.length > 0 ? Math.max(...dispatchTimestamps) : null;
  const oracleReadbackTimestamp = finiteMs(report?.output_proof?.outputOracle?.readbackTimestamp)
    ?? finiteMs(report?.output_proof?.output_oracle?.readback_timestamp);
  const outputProofDeltaMs =
    latestDispatchTimestamp !== null
    && oracleReadbackTimestamp !== null
    && oracleReadbackTimestamp >= latestDispatchTimestamp
      ? oracleReadbackTimestamp - latestDispatchTimestamp
      : null;
  const screenshotCaptureMs = sumMs(screenshotPhases.map((shot) => shot?.elapsedMs)) ?? 0;
  const normalizedTimings = normalizedTimingFields({
    staticDiscoveryTimeMs: finiteMs(report?.staticDiscoveryTimeMs)
      ?? finiteMs(report?.static_discovery_time_ms)
      ?? 0,
    aiContractSynthesisTimeMs: splitLatencyMs ?? finiteMs(firstCompile?.compile_wall_ms) ?? 0,
    modelAvailabilityCheckTimeMs: modelAvailability,
    artifactHashTimeMs: 0,
    adapterGenerationTimeMs: 0,
    deviceCompileWallTimeMs: hotCompileMs,
    artifactLoadTimeMs: 0,
    epochPublishTimeMs: 0,
    dispatchTraceTimeMs: outputProofDeltaMs ?? 0,
    runtimeProbeTimeMs: keyValueTiming(upstream?.timings, 'run_ms'),
    oracleAnalysisTimeMs: outputProofDeltaMs ?? 0,
    triggerToVisibleTimeMs: finiteMs(report?.output_proof?.outputOracle?.readbackTimestamp)
      ? hotSignalMs
      : null,
    screenshotCaptureTimeMs: screenshotCaptureMs,
    dispatchToOutputProofTimeMs: outputProofDeltaMs ?? 0,
    totalValidatorWallTimeMs: clockEvidence.durationMonotonicMs ?? report?.duration_ms,
  });

  return {
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    source: 'real_rocm_validation',
    metricClock: clockEvidence.metricClock,
    metric_clock: clockEvidence.metric_clock,
    metricUnit: clockEvidence.metricUnit,
    metric_unit: clockEvidence.metric_unit,
    metricScope: metricScope(report, 'hot_delta_1'),
    metric_scope: metricScope(report, 'hot_delta_1'),
    cacheState: cacheState(report),
    cache_state: cacheState(report),
    profileId: report?.slug ?? null,
    projectName: report?.target_name ?? null,
    proofMode: report?.hiprt_runtime_probe?.enabled ? 'real_rocm_hiprt_probe' : 'real_rocm',
    status: realRocmStatus(report),
    totalWallMs: clockEvidence.durationMonotonicMs ?? finiteMs(report?.duration_ms),
    setupBuildMs,
    adapterBuildMs: null,
    runtimeReadyMs: keyValueTiming(upstream?.timings, 'run_ms'),
    initialCompileWallMs: finiteMs(firstCompile?.compile_wall_ms) ?? compileWalls[0] ?? null,
    sourceWriteMs: null,
    modelAvailabilityCheckMs: modelAvailability,
    modelProvenance,
    aiDeltaWallMs: report?.evidence?.ai_call_counts?.gpu_delta > 0
      ? hotCompileMs
      : null,
    hotHmrCompileWallMs: hotCompileMs,
    sameProcessLiveRecompileMs: null,
    sameProcessTriggerWaitMs: null,
    hotReloadSignalMs: hotSignalMs,
    editToFirstVisualMs: null,
    beforeCaptureMs: null,
    afterCaptureMs: null,
    visualDiffMs: null,
    teardownMs: null,
    normalizedTimings,
    normalized_timings: normalizedTimings.snake_case,
    clockEvidence,
    clock_evidence: clockEvidence,
    visualEvidence: {
      screenshotCount: screenshotPhases.length,
      acceptedScreenshotCount: screenshotPhases.filter((shot) =>
        shot?.accepted_as_visual_evidence === true
      ).length,
      accepted: screenshotPhases.some((shot) => shot?.accepted_as_visual_evidence === true),
    },
    phases: [
      phase('upstream_configure_build', sumMs([
        keyValueTiming(upstream?.timings, 'configure_ms'),
        keyValueTiming(upstream?.timings, 'build_ms'),
      ]), 'phases.upstream_gpu_build_run.timings'),
      phase('upstream_run', keyValueTiming(upstream?.timings, 'run_ms'), 'phases.upstream_gpu_build_run.timings'),
      phase('initial_compile', firstCompile?.compile_wall_ms ?? compileWalls[0], 'phases[].compile_wall_ms'),
      phase('hot_hmr_compile', hotCompileMs, 'phases[].compile_wall_ms'),
      phase('hot_reload_signal', hotSignalMs, 'phases[].wait_hmr_elapsed_ms|wait_call_wall_ms'),
    ],
  };
}
