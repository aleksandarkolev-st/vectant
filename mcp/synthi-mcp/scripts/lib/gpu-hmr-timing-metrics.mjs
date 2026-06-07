export const GPU_HMR_TIMING_METRICS_SCHEMA_VERSION = 'synthi.gpu.hmr.timing_metrics.v1';

function finiteMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
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

export function externalProjectTimingMetrics(report) {
  const timings = report?.timings ?? {};
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

  return {
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    source: 'external_project_profile',
    profileId: report?.profile?.id ?? null,
    projectName: report?.profile?.project?.name ?? null,
    proofMode: report?.proofMode ?? null,
    status: report?.status ?? null,
    totalWallMs: finiteMs(timings.totalMs),
    setupBuildMs: finiteMs(timings.buildMs),
    adapterBuildMs: null,
    runtimeReadyMs: finiteMs(timings.runtimeReadyMs),
    initialCompileWallMs: finiteMs(timings.beforeCompileWallMs),
    sourceWriteMs: finiteMs(timings.sourceWriteMs),
    modelAvailabilityCheckMs: modelAvailabilityCheckMs(modelProvenance),
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

  return {
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    source: 'hiprt_warm_runtime',
    profileId: proof?.profile?.id ?? proof?.runtimeProfile?.id ?? null,
    projectName: proof?.repo?.target ?? null,
    proofMode: timings.mode ?? proof?.mode ?? null,
    status: proof?.accepted === true ? 'pass' : 'fail',
    totalWallMs: finiteMs(timings.totalWallMs),
    setupBuildMs: finiteMs(timings.sameProcessAdapterBuildMs),
    adapterBuildMs: finiteMs(timings.sameProcessAdapterBuildMs),
    runtimeReadyMs: beforeCaptureMs,
    initialCompileWallMs: null,
    sourceWriteMs,
    modelAvailabilityCheckMs: modelAvailabilityCheckMs(modelProvenance),
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

  return {
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    source: 'real_rocm_validation',
    profileId: report?.slug ?? null,
    projectName: report?.target_name ?? null,
    proofMode: report?.hiprt_runtime_probe?.enabled ? 'real_rocm_hiprt_probe' : 'real_rocm',
    status: realRocmStatus(report),
    totalWallMs: finiteMs(report?.duration_ms),
    setupBuildMs: sumMs([
      keyValueTiming(upstream?.timings, 'configure_ms'),
      keyValueTiming(upstream?.timings, 'build_ms'),
    ]),
    adapterBuildMs: null,
    runtimeReadyMs: keyValueTiming(upstream?.timings, 'run_ms'),
    initialCompileWallMs: finiteMs(firstCompile?.compile_wall_ms) ?? compileWalls[0] ?? null,
    sourceWriteMs: null,
    modelAvailabilityCheckMs: modelAvailabilityCheckMs(modelProvenance),
    modelProvenance,
    aiDeltaWallMs: report?.evidence?.ai_call_counts?.gpu_delta > 0
      ? finiteMs(deltaCompile?.compile_wall_ms) ?? maxMs(compileWalls.slice(1))
      : null,
    hotHmrCompileWallMs: finiteMs(deltaCompile?.compile_wall_ms) ?? maxMs(compileWalls.slice(1)),
    sameProcessLiveRecompileMs: null,
    sameProcessTriggerWaitMs: null,
    hotReloadSignalMs: finiteMs(deltaCompile?.wait_hmr_elapsed_ms) ?? maxMs(waitWalls),
    editToFirstVisualMs: null,
    beforeCaptureMs: null,
    afterCaptureMs: null,
    visualDiffMs: null,
    teardownMs: null,
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
      phase('hot_hmr_compile', deltaCompile?.compile_wall_ms ?? maxMs(compileWalls.slice(1)), 'phases[].compile_wall_ms'),
      phase('hot_reload_signal', deltaCompile?.wait_hmr_elapsed_ms ?? maxMs(waitWalls), 'phases[].wait_hmr_elapsed_ms|wait_call_wall_ms'),
    ],
  };
}
