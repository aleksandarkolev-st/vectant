import sharp from 'sharp';

const MIN_VISUAL_WIDTH = 320;
const MIN_VISUAL_HEIGHT = 240;
const MIN_VISIBLE_PIXELS = 500;
const FLAT_LUMA_STDDEV = 4;
const FLAT_RGB_SPAN_MEAN = 12;
const FLAT_UNIQUE_COLOR_SAMPLE_COUNT = 16;
const CONVERGENCE_METRICS = new Set([
  'per_frame_delta',
  'window_mean_delta',
  'stable_histogram_delta',
  'oracle_region_delta',
]);

export const GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION =
  'synthi.gpu_hmr.deterministic_visual_mode.v1';

function numeric(value) {
  return Number.isFinite(value) ? value : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstBool(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function compactStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(textOrNull)
    .filter(Boolean))];
}

function normalizeFrameHashes(...values) {
  return compactStringList(values.flatMap((value) => (
    Array.isArray(value) ? value : []
  )));
}

function normalizeConvergenceSamples(value) {
  return (Array.isArray(value) ? value : [])
    .filter((sample) => isObject(sample))
    .map((sample) => ({
      frame: finiteNumberOrNull(sample.frame ?? sample.frame_index ?? sample.frameIndex),
      epoch: textOrNull(sample.epoch ?? sample.epoch_id ?? sample.epochId),
      metric_value: finiteNumberOrNull(
        sample.metric_value ?? sample.metricValue ?? sample.value,
      ),
      artifact_hash: textOrNull(
        sample.artifact_hash ?? sample.artifactHash ?? sample.frame_hash ?? sample.frameHash,
      ),
      after_epoch_dispatch: boolOrNull(
        sample.after_epoch_dispatch ?? sample.afterEpochDispatch,
      ),
    }));
}

function addGate(failedGates, code, detail = {}) {
  failedGates.push({ code, ...detail });
}

function normalizeConvergenceWindow(value = {}) {
  const window = isObject(value) ? value : {};
  const metricValue = textOrNull(window.metric?.value ?? window.metric);
  const frameStart = finiteNumberOrNull(window.frame_start ?? window.frameStart);
  const frameEnd = finiteNumberOrNull(window.frame_end ?? window.frameEnd);
  const samples = normalizeConvergenceSamples(window.samples);
  const frameHashes = normalizeFrameHashes(
    window.frame_hashes,
    window.frameHashes,
    window.post_epoch_frame_hashes,
    window.postEpochFrameHashes,
  );
  const preEpochFrameHashes = normalizeFrameHashes(
    window.pre_epoch_frame_hashes,
    window.preEpochFrameHashes,
  );
  const postEpochFrameHashes = normalizeFrameHashes(
    window.post_epoch_frame_hashes,
    window.postEpochFrameHashes,
  );
  const sampleCount = finiteNumberOrNull(window.sample_count ?? window.sampleCount)
    ?? (samples.length > 0 ? samples.length : null)
    ?? (frameHashes.length > 0 ? frameHashes.length : null);
  return {
    frame_start: frameStart,
    frame_end: frameEnd,
    metric: metricValue ? { value: metricValue } : null,
    min_frames:
      finiteNumberOrNull(window.min_frames ?? window.minFrames)
      ?? (frameStart !== null && frameEnd !== null ? Math.max(0, frameEnd - frameStart + 1) : null),
    sample_count: sampleCount,
    samples,
    frame_hashes: frameHashes,
    pre_epoch_frame_hashes: preEpochFrameHashes,
    post_epoch_frame_hashes: postEpochFrameHashes,
    metric_value: finiteNumberOrNull(window.metric_value ?? window.metricValue),
    metric_delta: finiteNumberOrNull(
      window.metric_delta
      ?? window.metricDelta
      ?? window.observed_delta
      ?? window.observedDelta
      ?? window.window_delta
      ?? window.windowDelta
      ?? window.mean_delta
      ?? window.meanDelta,
    ),
    threshold: finiteNumberOrNull(window.threshold ?? window.delta_threshold ?? window.deltaThreshold),
    convergence_proven: boolOrNull(
      window.convergence_proven
      ?? window.convergenceProven
      ?? window.proven,
    ),
    evidence_refs: compactStringList(window.evidence_refs ?? window.evidenceRefs),
    producer_subsystem: textOrNull(window.producer_subsystem ?? window.producerSubsystem),
  };
}

function controlSatisfied(mode, disabledKey, presentKey, notApplicableKey) {
  return mode[disabledKey] === true
    || mode[presentKey] === false
    || mode[notApplicableKey] === true;
}

function seedPolicyFixed(mode) {
  return mode.fixed_seed === true
    || mode.seed_policy_fixed === true
    || Boolean(textOrNull(mode.seed_policy_hash));
}

function convergenceWindowAccepted(window) {
  const metric = window.metric?.value ?? null;
  const frameRangeValid = window.frame_start !== null
    && window.frame_end !== null
    && window.frame_end >= window.frame_start;
  if (!frameRangeValid || !CONVERGENCE_METRICS.has(metric)) return false;
  const requiredSamples = Math.max(2, finiteNumberOrNull(window.min_frames) ?? 2);
  const observedSamples = finiteNumberOrNull(window.sample_count) ?? 0;
  const hasSampleEvidence = observedSamples >= requiredSamples
    || window.samples.length >= requiredSamples
    || window.frame_hashes.length >= requiredSamples
    || window.post_epoch_frame_hashes.length >= requiredSamples;
  const hasMetricEvidence =
    window.metric_value !== null
    || window.metric_delta !== null
    || window.samples.some((sample) => sample.metric_value !== null);
  return hasSampleEvidence
    && hasMetricEvidence
    && window.convergence_proven === true
    && window.evidence_refs.length > 0;
}

function screenshotDimension(shot, key) {
  const meta = isObject(shot?.screenshot_metadata ?? shot?.screenshotMetadata)
    ? (shot.screenshot_metadata ?? shot.screenshotMetadata)
    : {};
  return finiteNumberOrNull(shot?.[key] ?? meta[key]);
}

export function mcpFrameGateSatisfied(waitOrGate) {
  const gate = isObject(waitOrGate?.frame_gate ?? waitOrGate?.frameGate)
    ? (waitOrGate.frame_gate ?? waitOrGate.frameGate)
    : waitOrGate;
  return isObject(gate) && gate.status === 'satisfied';
}

export function deterministicVisualModeFromMcpEvidence(input = {}) {
  const evidence = isObject(input) ? input : {};
  const base = isObject(evidence.base ?? evidence.deterministicMode)
    ? (evidence.base ?? evidence.deterministicMode)
    : {};
  const before = evidence.before ?? evidence.beforeScreenshot ?? null;
  const after = evidence.after ?? evidence.afterScreenshot ?? null;
  const beforeWidth = screenshotDimension(before, 'width');
  const beforeHeight = screenshotDimension(before, 'height');
  const afterWidth = screenshotDimension(after, 'width');
  const afterHeight = screenshotDimension(after, 'height');
  const sameResolution = beforeWidth !== null
    && beforeHeight !== null
    && afterWidth !== null
    && afterHeight !== null
    && beforeWidth > 0
    && beforeHeight > 0
    && beforeWidth === afterWidth
    && beforeHeight === afterHeight;
  const frameGate = evidence.frameGate ?? evidence.wait?.frame_gate ?? evidence.wait?.frameGate;
  const frameBoundary = mcpFrameGateSatisfied(frameGate);
  return normalizeGpuHmrDeterministicVisualMode({
    ...base,
    fixed_seed: firstBool(evidence.fixed_seed, evidence.fixedSeed, base.fixed_seed, base.fixedSeed),
    seed_policy_fixed: firstBool(
      evidence.seed_policy_fixed,
      evidence.seedPolicyFixed,
      base.seed_policy_fixed,
      base.seedPolicyFixed,
    ),
    seed_policy_hash: textOrNull(
      evidence.seed_policy_hash
      ?? evidence.seedPolicyHash
      ?? base.seed_policy_hash
      ?? base.seedPolicyHash,
    ),
    frozen_camera: firstBool(
      evidence.frozen_camera,
      evidence.frozenCamera,
      base.frozen_camera,
      base.frozenCamera,
    ),
    temporal_accumulation_disabled: firstBool(
      evidence.temporal_accumulation_disabled,
      evidence.temporalAccumulationDisabled,
      base.temporal_accumulation_disabled,
      base.temporalAccumulationDisabled,
    ),
    temporal_accumulation_present: firstBool(
      evidence.temporal_accumulation_present,
      evidence.temporalAccumulationPresent,
      base.temporal_accumulation_present,
      base.temporalAccumulationPresent,
    ),
    temporal_accumulation_not_applicable: firstBool(
      evidence.temporal_accumulation_not_applicable,
      evidence.temporalAccumulationNotApplicable,
      base.temporal_accumulation_not_applicable,
      base.temporalAccumulationNotApplicable,
    ),
    taa_disabled: firstBool(evidence.taa_disabled, evidence.taaDisabled, base.taa_disabled, base.taaDisabled),
    taa_present: firstBool(evidence.taa_present, evidence.taaPresent, base.taa_present, base.taaPresent),
    taa_not_applicable: firstBool(
      evidence.taa_not_applicable,
      evidence.taaNotApplicable,
      base.taa_not_applicable,
      base.taaNotApplicable,
    ),
    denoiser_disabled: firstBool(
      evidence.denoiser_disabled,
      evidence.denoiserDisabled,
      base.denoiser_disabled,
      base.denoiserDisabled,
    ),
    denoiser_present: firstBool(
      evidence.denoiser_present,
      evidence.denoiserPresent,
      base.denoiser_present,
      base.denoiserPresent,
    ),
    denoiser_not_applicable: firstBool(
      evidence.denoiser_not_applicable,
      evidence.denoiserNotApplicable,
      base.denoiser_not_applicable,
      base.denoiserNotApplicable,
    ),
    fixed_resolution: sameResolution === true
      ? true
      : firstBool(evidence.fixed_resolution, evidence.fixedResolution, base.fixed_resolution, base.fixedResolution),
    fixed_swapchain_image_count: firstBool(
      evidence.fixed_swapchain_image_count,
      evidence.fixedSwapchainImageCount,
      base.fixed_swapchain_image_count,
      base.fixedSwapchainImageCount,
    ),
    frame_capture_after_epoch_dispatch: frameBoundary === true
      ? true
      : firstBool(
          evidence.frame_capture_after_epoch_dispatch,
          evidence.frameCaptureAfterEpochDispatch,
          base.frame_capture_after_epoch_dispatch,
          base.frameCaptureAfterEpochDispatch,
        ),
    presentation_fence_or_frame_boundary: frameBoundary === true
      ? true
      : firstBool(
          evidence.presentation_fence_or_frame_boundary,
          evidence.presentationFenceOrFrameBoundary,
          base.presentation_fence_or_frame_boundary,
          base.presentationFenceOrFrameBoundary,
        ),
    warmup_frames:
      finiteNumberOrNull(evidence.warmup_frames ?? evidence.warmupFrames)
      ?? finiteNumberOrNull(base.warmup_frames ?? base.warmupFrames),
    convergence_window: evidence.convergence_window ?? evidence.convergenceWindow
      ?? base.convergence_window ?? base.convergenceWindow,
  });
}

export function normalizeGpuHmrDeterministicVisualMode(input = {}) {
  const mode = isObject(input) ? input : {};
  const convergenceWindow = normalizeConvergenceWindow(
    mode.convergence_window ?? mode.convergenceWindow,
  );
  return {
    schema_version:
      textOrNull(mode.schema_version ?? mode.schemaVersion)
      ?? GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
    fixed_seed: boolOrNull(mode.fixed_seed ?? mode.fixedSeed),
    seed_policy_fixed: boolOrNull(mode.seed_policy_fixed ?? mode.seedPolicyFixed),
    seed_policy_hash: textOrNull(mode.seed_policy_hash ?? mode.seedPolicyHash),
    frozen_camera: boolOrNull(mode.frozen_camera ?? mode.frozenCamera),
    temporal_accumulation_disabled:
      boolOrNull(mode.temporal_accumulation_disabled ?? mode.temporalAccumulationDisabled),
    temporal_accumulation_present:
      boolOrNull(mode.temporal_accumulation_present ?? mode.temporalAccumulationPresent),
    temporal_accumulation_not_applicable:
      boolOrNull(mode.temporal_accumulation_not_applicable ?? mode.temporalAccumulationNotApplicable),
    taa_disabled: boolOrNull(mode.taa_disabled ?? mode.taaDisabled),
    taa_present: boolOrNull(mode.taa_present ?? mode.taaPresent),
    taa_not_applicable: boolOrNull(mode.taa_not_applicable ?? mode.taaNotApplicable),
    denoiser_disabled: boolOrNull(mode.denoiser_disabled ?? mode.denoiserDisabled),
    denoiser_present: boolOrNull(mode.denoiser_present ?? mode.denoiserPresent),
    denoiser_not_applicable: boolOrNull(mode.denoiser_not_applicable ?? mode.denoiserNotApplicable),
    fixed_resolution: boolOrNull(mode.fixed_resolution ?? mode.fixedResolution),
    fixed_swapchain_image_count:
      boolOrNull(mode.fixed_swapchain_image_count ?? mode.fixedSwapchainImageCount),
    frame_capture_after_epoch_dispatch:
      boolOrNull(mode.frame_capture_after_epoch_dispatch ?? mode.frameCaptureAfterEpochDispatch),
    presentation_fence_or_frame_boundary:
      boolOrNull(mode.presentation_fence_or_frame_boundary ?? mode.presentationFenceOrFrameBoundary),
    warmup_frames: finiteNumberOrNull(mode.warmup_frames ?? mode.warmupFrames),
    convergence_window: convergenceWindow,
  };
}

export function evaluateGpuHmrDeterministicVisualMode(input = {}) {
  const mode = normalizeGpuHmrDeterministicVisualMode(input);
  const failedGates = [];
  const warnings = [];
  const convergenceAccepted = convergenceWindowAccepted(mode.convergence_window);
  const temporalControlled = controlSatisfied(
    mode,
    'temporal_accumulation_disabled',
    'temporal_accumulation_present',
    'temporal_accumulation_not_applicable',
  );
  const taaControlled = controlSatisfied(mode, 'taa_disabled', 'taa_present', 'taa_not_applicable');
  const denoiserControlled = controlSatisfied(
    mode,
    'denoiser_disabled',
    'denoiser_present',
    'denoiser_not_applicable',
  );

  if (mode.schema_version !== GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION) {
    addGate(failedGates, 'deterministic_visual_mode_schema_unsupported', {
      expected: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
      actual: mode.schema_version,
    });
  }
  if (mode.frozen_camera !== true) addGate(failedGates, 'frozen_camera_unproven');
  if (mode.fixed_resolution !== true) addGate(failedGates, 'fixed_resolution_unproven');
  if (mode.frame_capture_after_epoch_dispatch !== true) {
    addGate(failedGates, 'frame_capture_after_epoch_dispatch_unproven');
  }
  if (mode.presentation_fence_or_frame_boundary !== true) {
    addGate(failedGates, 'presentation_boundary_unproven');
  }
  if (mode.fixed_swapchain_image_count !== true) {
    addGate(failedGates, 'fixed_swapchain_image_count_unproven');
  }
  if (!seedPolicyFixed(mode) && !convergenceAccepted) {
    addGate(failedGates, 'seed_policy_unproven');
  }
  if (!seedPolicyFixed(mode) && convergenceAccepted) {
    addGate(failedGates, 'seed_policy_unproven');
  }
  if (mode.convergence_window.frame_start !== null || mode.convergence_window.frame_end !== null) {
    const window = mode.convergence_window;
    const requiredSamples = Math.max(2, finiteNumberOrNull(window.min_frames) ?? 2);
    const observedSamples = finiteNumberOrNull(window.sample_count) ?? 0;
    if (window.metric?.value && !CONVERGENCE_METRICS.has(window.metric.value)) {
      addGate(failedGates, 'convergence_window_metric_unsupported', {
        metric: window.metric.value,
      });
    }
    if (
      observedSamples < requiredSamples
      && window.samples.length < requiredSamples
      && window.frame_hashes.length < requiredSamples
      && window.post_epoch_frame_hashes.length < requiredSamples
    ) {
      addGate(failedGates, 'convergence_window_sample_evidence_missing', {
        requiredSamples,
        observedSamples,
      });
    }
    if (
      window.metric_value === null
      && window.metric_delta === null
      && !window.samples.some((sample) => sample.metric_value !== null)
    ) {
      addGate(failedGates, 'convergence_window_metric_evidence_missing');
    }
    if (window.convergence_proven !== true) {
      addGate(failedGates, 'convergence_window_proof_missing');
    }
    if (window.evidence_refs.length === 0) {
      addGate(failedGates, 'convergence_window_evidence_refs_missing');
    }
  }
  if (!temporalControlled && !convergenceAccepted) {
    addGate(failedGates, 'temporal_visual_requires_convergence_window');
  }
  if (!taaControlled && !convergenceAccepted) addGate(failedGates, 'taa_control_unproven');
  if (!denoiserControlled && !convergenceAccepted) addGate(failedGates, 'denoiser_control_unproven');

  return {
    schemaVersion: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
    mode,
    accepted: failedGates.length === 0,
    proofMode: convergenceAccepted ? 'convergence_window' : 'single_frame_deterministic',
    failedGates,
    warnings,
  };
}

export function deterministicVisualModeAccepted(mode = {}) {
  return evaluateGpuHmrDeterministicVisualMode(mode).accepted === true;
}

export function classifyGpuHmrVisualEvidenceStats(stats = {}) {
  const width = Number(stats.width);
  const height = Number(stats.height);
  const visiblePixels = Number(stats.visible_pixels ?? stats.visiblePixels);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'gpu-hmr-visual-unmeasured';
  }
  if (width < MIN_VISUAL_WIDTH || height < MIN_VISUAL_HEIGHT) {
    return 'gpu-hmr-visual-too-small';
  }
  if (!Number.isFinite(visiblePixels) || visiblePixels <= 0) {
    return 'gpu-hmr-visual-blank';
  }
  if (visiblePixels <= MIN_VISIBLE_PIXELS) {
    return 'gpu-hmr-visual-low-visible-pixels';
  }

  const lumaStddev = Number(stats.luma_stddev ?? stats.lumaStddev);
  const rgbSpanMean = Number(stats.rgb_span_mean ?? stats.rgbSpanMean);
  const uniqueColorSampleCount = Number(
    stats.unique_color_sample_count ?? stats.uniqueColorSampleCount,
  );
  const hasVariation = (
    (Number.isFinite(lumaStddev) && lumaStddev >= FLAT_LUMA_STDDEV)
    || (Number.isFinite(rgbSpanMean) && rgbSpanMean >= FLAT_RGB_SPAN_MEAN)
    || (Number.isFinite(uniqueColorSampleCount)
      && uniqueColorSampleCount >= FLAT_UNIQUE_COLOR_SAMPLE_COUNT)
  );
  return hasVariation ? 'gpu-hmr-visual-varied-frame' : 'gpu-hmr-visual-flat-frame';
}

export function screenshotQualifiesAsVisualEvidence(shot) {
  const quality = shot?.visual_quality ?? shot?.visualQuality ?? classifyGpuHmrVisualEvidenceStats(shot);
  return Boolean(
    shot
      && Number(shot.width) >= MIN_VISUAL_WIDTH
      && Number(shot.height) >= MIN_VISUAL_HEIGHT
      && Number(shot.visible_pixels ?? shot.visiblePixels) > MIN_VISIBLE_PIXELS
      && quality === 'gpu-hmr-visual-varied-frame'
      && typeof (shot.path ?? shot.filePath ?? shot.file_path) === 'string'
      && String(shot.path ?? shot.filePath ?? shot.file_path).trim(),
  );
}

export async function analyzeGpuHmrImageEvidence(input) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let visible = 0;
  let lumaTotal = 0;
  let lumaSquareTotal = 0;
  const minChannel = [255, 255, 255];
  const maxChannel = [0, 0, 0];
  const uniqueSamples = new Set();
  const pixels = Math.max(1, info.width * info.height);
  const sampleStride = Math.max(1, Math.floor(pixels / 8192));
  let pixelIndex = 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaTotal += luma;
    lumaSquareTotal += luma * luma;
    if (luma > 24 || Math.max(r, g, b) - Math.min(r, g, b) > 30) visible += 1;
    minChannel[0] = Math.min(minChannel[0], r);
    minChannel[1] = Math.min(minChannel[1], g);
    minChannel[2] = Math.min(minChannel[2], b);
    maxChannel[0] = Math.max(maxChannel[0], r);
    maxChannel[1] = Math.max(maxChannel[1], g);
    maxChannel[2] = Math.max(maxChannel[2], b);
    if (pixelIndex % sampleStride === 0) {
      uniqueSamples.add(`${r},${g},${b}`);
    }
    pixelIndex += 1;
  }

  const meanLuma = lumaTotal / pixels;
  const variance = Math.max(0, (lumaSquareTotal / pixels) - (meanLuma * meanLuma));
  const rgbSpanMean = (
    (maxChannel[0] - minChannel[0])
    + (maxChannel[1] - minChannel[1])
    + (maxChannel[2] - minChannel[2])
  ) / 3;
  const stats = {
    width: info.width,
    height: info.height,
    visible_pixels: visible,
    mean_luma: meanLuma,
    luma_stddev: Math.sqrt(variance),
    rgb_span_mean: rgbSpanMean,
    unique_color_sample_count: uniqueSamples.size,
  };
  return {
    ...stats,
    visual_quality: classifyGpuHmrVisualEvidenceStats(stats),
  };
}

export function visualEvidenceRow(extra = {}) {
  const row = {
    ...extra,
    width: numeric(Number(extra.width)),
    height: numeric(Number(extra.height)),
    visible_pixels: numeric(Number(extra.visible_pixels ?? extra.visiblePixels)),
    mean_luma: numeric(Number(extra.mean_luma ?? extra.meanLuma)),
    luma_stddev: numeric(Number(extra.luma_stddev ?? extra.lumaStddev)),
    rgb_span_mean: numeric(Number(extra.rgb_span_mean ?? extra.rgbSpanMean)),
    unique_color_sample_count: numeric(Number(
      extra.unique_color_sample_count ?? extra.uniqueColorSampleCount,
    )),
  };
  row.visual_quality = extra.visual_quality
    ?? extra.visualQuality
    ?? classifyGpuHmrVisualEvidenceStats(row);
  row.accepted_as_visual_evidence = screenshotQualifiesAsVisualEvidence(row);
  return row;
}
