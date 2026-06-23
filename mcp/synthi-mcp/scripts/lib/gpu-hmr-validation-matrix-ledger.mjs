import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { queryGpuHmrLedgerInvariants } from './gpu-hmr-proof-ledger.mjs';
import { classifyGpuHmrFissionProof } from './gpu-hmr-runtime-proof.mjs';
import { runtimeProofArtifactStrictGate } from './gpu-hmr-proof-strict-gates.mjs';
import { computeOracleArtifactsFromFiles } from './gpu-hmr-validation-proof-artifact.mjs';

export const GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION =
  'synthi.gpu.hmr.validation_matrix_ledger.v1';
export const GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION =
  'synthi.gpu.hmr.validation_matrix_row.v1';

const MATRIX_OUTCOME_PRIORITY = new Map([
  ['full_runtime_gpu_hmr', 100],
  ['visual_profile_accepted', 70],
  ['deterministic_fission_proven', 60],
  ['cold_split_proven', 55],
  ['preflight_only', 50],
  ['refusal_proven', 40],
  ['unproven', 0],
]);

const ACCEPTED_METRIC_SCOPES = new Set(['cold', 'warm', 'hot_delta_1', 'hot_delta_2']);
const ACCEPTED_CACHE_STATES = new Set(['clean', 'compiler_cache_warm', 'pipeline_cache_warm']);
const REQUIRED_FULL_TARGET_RUN_MODES = ['cold', 'hot_delta_1', 'hot_delta_2'];

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function proofIdFor(prefix, value) {
  return `${prefix}:sha256:${sha256Hex(stableJson(value))}`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function firstBool(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(text)
    .filter(Boolean))];
}

function compactObject(value) {
  return isObject(value) ? value : {};
}

function compactObjectList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(compactObject)
    .filter((entry) => Object.keys(entry).length > 0);
}

function eventList(...values) {
  for (const value of values) {
    const list = compactObjectList(value);
    if (list.length > 0) return list;
  }
  return [];
}

function eventByEpoch(events, epoch) {
  const expected = Number(epoch);
  return compactObject(events.find((event) => Number(event.epoch) === expected));
}

function eventTimestampNs(event) {
  return finiteNumber(
    event.timestamp_monotonic_ns
    ?? event.timestampMonotonicNs
    ?? event.timestamp_ns
    ?? event.timestampNs
    ?? event.timestamp,
  );
}

function isSelfCheckId(value) {
  return /\bself[-_ ]?check\b/i.test(String(value ?? ''));
}

function objectCandidates(...values) {
  const out = [];
  const visit = (value) => {
    if (!isObject(value)) return;
    out.push(value);
    for (const key of [
      'timingMetrics',
      'timing_metrics',
      'timings',
      'normalizedTimings',
      'normalized_timings',
      'clockEvidence',
      'clock_evidence',
    ]) {
      if (isObject(value[key])) visit(value[key]);
    }
  };
  values.forEach(visit);
  return out;
}

function firstObjectField(candidates, ...keys) {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = firstText(candidate[key]);
      if (value) return value;
    }
  }
  return null;
}

function timingEvidence(...values) {
  const candidates = objectCandidates(...values);
  const metricClock = firstObjectField(candidates, 'metricClock', 'metric_clock');
  const metricScope = firstObjectField(candidates, 'metricScope', 'metric_scope');
  const cacheState = firstObjectField(candidates, 'cacheState', 'cache_state');
  const editId = firstObjectField(candidates, 'editId', 'edit_id');
  const editHash = firstObjectField(candidates, 'editHash', 'edit_hash');
  const editKind = firstObjectField(candidates, 'editKind', 'edit_kind');
  const differentEdit = candidates.some((candidate) =>
    candidate.differentEdit === true || candidate.different_edit === true
  );
  const metricScopeAccepted = metricScope ? ACCEPTED_METRIC_SCOPES.has(metricScope) : false;
  const cacheStateAccepted = cacheState ? ACCEPTED_CACHE_STATES.has(cacheState) : false;
  const accepted = metricClock === 'monotonic_ns' && metricScopeAccepted && cacheStateAccepted;
  return {
    present: Boolean(metricClock || metricScope || cacheState),
    accepted,
    metricClock,
    metricScope,
    cacheState,
    editId,
    editHash,
    editKind,
    differentEdit,
    different_edit: differentEdit,
    failedGates: compactStringList([
      metricClock === 'monotonic_ns' ? null : 'metric_clock_monotonic_ns_missing',
      metricScopeAccepted ? null : 'metric_scope_missing_or_unsupported',
      cacheStateAccepted ? null : 'cache_state_missing_or_unsupported',
    ]),
  };
}

function relPath(filePath, repoRoot) {
  if (!filePath) return null;
  const absolute = path.resolve(String(filePath));
  const relative = path.relative(repoRoot, absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative
    : absolute;
}

function normalizeMaybeWindowsPath(value) {
  const raw = text(value);
  if (!raw) return null;
  return raw.replace(/\\/g, path.sep);
}

function resolveEvidencePath(value, repoRoot, baseDir = repoRoot) {
  const normalized = normalizeMaybeWindowsPath(value);
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) return path.resolve(normalized);
  const repoResolved = path.resolve(repoRoot, normalized);
  return repoResolved.startsWith(repoRoot) ? repoResolved : path.resolve(baseDir, normalized);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pngEvidence(filePath) {
  if (!filePath) {
    return {
      path: null,
      exists: false,
      sizeBytes: null,
      pngSignatureValid: false,
      decoded: false,
      decodeError: null,
      format: null,
      width: null,
      height: null,
    };
  }
  try {
    const stat = await fs.stat(filePath);
    let decodeEvidence = {
      decoded: false,
      decodeError: null,
      format: null,
      width: null,
      height: null,
    };
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(8);
      const { bytesRead } = await handle.read(buffer, 0, 8, 0);
      const pngSignatureValid =
        bytesRead === 8
        && buffer[0] === 0x89
        && buffer[1] === 0x50
        && buffer[2] === 0x4e
        && buffer[3] === 0x47
        && buffer[4] === 0x0d
        && buffer[5] === 0x0a
        && buffer[6] === 0x1a
        && buffer[7] === 0x0a;
      if (pngSignatureValid) {
        try {
          const metadata = await sharp(filePath).metadata();
          const decoded =
            metadata.format === 'png'
            && Number.isFinite(metadata.width)
            && Number.isFinite(metadata.height)
            && metadata.width > 0
            && metadata.height > 0;
          decodeEvidence = {
            decoded,
            decodeError: decoded ? null : 'png_metadata_missing_dimensions',
            format: metadata.format ?? null,
            width: finiteNumber(metadata.width),
            height: finiteNumber(metadata.height),
          };
        } catch (err) {
          decodeEvidence = {
            decoded: false,
            decodeError: `png_decode_failed:${err?.code ?? err?.name ?? 'unknown'}`,
            format: null,
            width: null,
            height: null,
          };
        }
      }
      return {
        path: filePath,
        exists: true,
        sizeBytes: stat.size,
        pngSignatureValid,
        ...decodeEvidence,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return {
      path: filePath,
      exists: false,
      sizeBytes: null,
      pngSignatureValid: false,
      decoded: false,
      decodeError: 'file_not_found_or_unreadable',
      format: null,
      width: null,
      height: null,
    };
  }
}

async function visualArtifactEvidence(paths, repoRoot, baseDir, metrics = {}, required = false) {
  const resolved = compactStringList(paths)
    .map((value) => resolveEvidencePath(value, repoRoot, baseDir))
    .filter(Boolean);
  const evidence = [];
  for (const filePath of resolved) {
    const fileEvidence = await pngEvidence(filePath);
    evidence.push({
      ...fileEvidence,
      path: relPath(fileEvidence.path, repoRoot),
    });
  }
  const imageCount = evidence.length;
  const existingImageCount = evidence.filter((item) => item.exists).length;
  const pngImageCount = evidence.filter((item) => item.pngSignatureValid).length;
  const decodedImageCount = evidence.filter((item) => item.decoded).length;
  const allImagesExist = imageCount > 0 && existingImageCount === imageCount;
  const allImagesArePng = imageCount > 0 && pngImageCount === imageCount;
  const allImagesDecode = imageCount > 0 && decodedImageCount === imageCount;
  const allImagesAreDecodedPng = allImagesArePng && allImagesDecode;
  return {
    required,
    present: imageCount > 0,
    accepted: imageCount === 0
      ? required !== true
      : allImagesExist && allImagesAreDecodedPng,
    imageCount,
    existingImageCount,
    pngImageCount,
    decodedImageCount,
    allImagesExist,
    allImagesArePng,
    allImagesDecode,
    allImagesAreDecodedPng,
    changedPixelRatio: finiteNumber(metrics.changedPixelRatio ?? metrics.changed_pixel_ratio),
    meanAbsDelta8bit: finiteNumber(metrics.meanAbsDelta8bit ?? metrics.mean_abs_delta_8bit),
    visiblePixelCount: finiteNumber(metrics.visiblePixelCount ?? metrics.visible_pixel_count),
    images: evidence,
  };
}

function regionStatsFromRgba({ data, width, height, bounds }) {
  const x0 = Math.max(0, Math.min(width - 1, Number(bounds?.x0 ?? 0)));
  const y0 = Math.max(0, Math.min(height - 1, Number(bounds?.y0 ?? 0)));
  const x1 = Math.max(0, Math.min(width - 1, Number(bounds?.x1 ?? -1)));
  const y1 = Math.max(0, Math.min(height - 1, Number(bounds?.y1 ?? -1)));
  if (x1 < x0 || y1 < y0) {
    return {
      bounds: { x0: 0, y0: 0, x1: -1, y1: -1 },
      width: 0,
      height: 0,
      pixels: 0,
      visiblePixels: 0,
      visiblePixelRatio: 0,
      meanLuma8bit: 0,
      lumaStddev8bit: 0,
      meanRgbSpan8bit: 0,
      uniqueColorSampleCount: 0,
    };
  }
  let pixels = 0;
  let visiblePixels = 0;
  let lumaSum = 0;
  let lumaSqSum = 0;
  let rgbSpanSum = 0;
  const colorSample = new Set();
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const offset = (y * width + x) * 4;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      pixels += 1;
      if (r > 4 || g > 4 || b > 4) visiblePixels += 1;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lumaSum += luma;
      lumaSqSum += luma * luma;
      rgbSpanSum += Math.max(r, g, b) - Math.min(r, g, b);
      if (colorSample.size < 20000) colorSample.add(`${r},${g},${b}`);
    }
  }
  const meanLuma = pixels > 0 ? lumaSum / pixels : 0;
  const variance = pixels > 0 ? Math.max(0, (lumaSqSum / pixels) - meanLuma * meanLuma) : 0;
  return {
    bounds: { x0, y0, x1, y1 },
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    pixels,
    visiblePixels,
    visiblePixelRatio: pixels > 0 ? visiblePixels / pixels : 0,
    meanLuma8bit: meanLuma,
    lumaStddev8bit: Math.sqrt(variance),
    meanRgbSpan8bit: pixels > 0 ? rgbSpanSum / pixels : 0,
    uniqueColorSampleCount: colorSample.size,
  };
}

function oracleRegionThresholds(oracleRegion) {
  const thresholds = compactObject(oracleRegion?.thresholds);
  return {
    minVisibleRatio: finiteNumber(thresholds.minVisibleRatio ?? thresholds.min_visible_ratio) ?? 0.02,
    minMeanLuma8bit: finiteNumber(thresholds.minMeanLuma8bit ?? thresholds.min_mean_luma_8bit) ?? 4,
    minUniqueColorSampleCount:
      finiteNumber(thresholds.minUniqueColorSampleCount ?? thresholds.min_unique_color_sample_count) ?? 64,
  };
}

async function recomputeHiprtOracleRegion({ baselinePath, changedPath, oracleRegion }) {
  const thresholds = oracleRegionThresholds(oracleRegion);
  if (!baselinePath || !changedPath) {
    return {
      present: false,
      accepted: false,
      source: 'matrix_recomputed_png_pixels',
      thresholds,
      failedGates: [{ code: 'hiprt_oracle_region_capture_paths_missing' }],
    };
  }
  try {
    const baseline = await sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const changed = await sharp(changedPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (baseline.info.width !== changed.info.width || baseline.info.height !== changed.info.height) {
      return {
        present: true,
        accepted: false,
        source: 'matrix_recomputed_png_pixels',
        thresholds,
        baselinePath,
        changedPath,
        failedGates: [{ code: 'hiprt_oracle_region_dimension_mismatch' }],
      };
    }
    const width = baseline.info.width;
    const height = baseline.info.height;
    const pixels = width * height;
    const changedBounds = { x0: width, y0: height, x1: -1, y1: -1 };
    let changedPixelsThreshold4 = 0;
    for (let i = 0; i < pixels; i += 1) {
      const offset = i * 4;
      const maxDelta = Math.max(
        Math.abs(baseline.data[offset] - changed.data[offset]),
        Math.abs(baseline.data[offset + 1] - changed.data[offset + 1]),
        Math.abs(baseline.data[offset + 2] - changed.data[offset + 2]),
      );
      if (maxDelta > 4) {
        changedPixelsThreshold4 += 1;
        const x = i % width;
        const y = Math.floor(i / width);
        changedBounds.x0 = Math.min(changedBounds.x0, x);
        changedBounds.y0 = Math.min(changedBounds.y0, y);
        changedBounds.x1 = Math.max(changedBounds.x1, x);
        changedBounds.y1 = Math.max(changedBounds.y1, y);
      }
    }
    const bounds = changedPixelsThreshold4 > 0
      ? changedBounds
      : { x0: 0, y0: 0, x1: -1, y1: -1 };
    const baselineRegion = regionStatsFromRgba({
      data: baseline.data,
      width,
      height,
      bounds,
    });
    const changedRegion = regionStatsFromRgba({
      data: changed.data,
      width,
      height,
      bounds,
    });
    const nonBlankAfterEpoch =
      changedRegion.pixels > 0
      && changedRegion.visiblePixelRatio >= thresholds.minVisibleRatio
      && changedRegion.meanLuma8bit >= thresholds.minMeanLuma8bit
      && changedRegion.uniqueColorSampleCount >= thresholds.minUniqueColorSampleCount;
    return {
      present: true,
      accepted: nonBlankAfterEpoch,
      source: 'matrix_recomputed_png_pixels',
      baselinePath,
      changedPath,
      width,
      height,
      thresholds,
      changedPixelsThreshold4,
      changedPixelRatioThreshold4: pixels > 0 ? changedPixelsThreshold4 / pixels : 0,
      baseline: baselineRegion,
      changed: changedRegion,
      nonBlankAfterEpoch,
      blankFrameRejected: nonBlankAfterEpoch,
      failedGates: nonBlankAfterEpoch
        ? []
        : [{ code: 'hiprt_oracle_region_nonblank_pixel_recompute_failed' }],
    };
  } catch (error) {
    return {
      present: true,
      accepted: false,
      source: 'matrix_recomputed_png_pixels',
      thresholds,
      baselinePath,
      changedPath,
      failedGates: [{
        code: 'hiprt_oracle_region_pixel_recompute_error',
        message: error?.message ? String(error.message) : String(error),
      }],
    };
  }
}

function rowKey(row) {
  const runModeKey = (
    row.proofMode === 'run_mode_proof'
    || row.matrixOutcome === 'full_runtime_gpu_hmr'
    || row.matrixOutcome === 'cold_split_proven'
  )
    ? row.runMode?.metricScope ?? 'unknown'
    : null;
  return [
    row.backend ?? 'unknown',
    row.targetId ?? 'unknown',
    row.profileId ?? 'unknown',
    row.proofMode ?? 'unknown',
    runModeKey,
    row.evidenceKind ?? 'unknown',
    row.matrixOutcome ?? 'unknown',
  ].join('|');
}

function normalizeCoverageObligations(row) {
  const declared = compactObject(
    row.coverageObligations
      ?? row.coverage_obligations
      ?? row.validationCoverage
      ?? row.validation_coverage,
  );
  const declaredPerTargetRunModes = firstBool(
    declared.perTargetRunModes,
    declared.per_target_run_modes,
    declared.fullTargetRunModes,
    declared.full_target_run_modes,
  );
  if (declaredPerTargetRunModes !== null) {
    return {
      perTargetRunModes: declaredPerTargetRunModes,
      source: 'artifact_declared',
    };
  }
  const schemaInfersRunModeObligation = row.proofMode === 'run_mode_proof';
  return {
    perTargetRunModes: schemaInfersRunModeObligation,
    source: schemaInfersRunModeObligation ? 'schema_inferred_run_mode_proof' : 'not_obligated',
  };
}

function rowRequiresPerTargetRunModes(row) {
  return row.coverageObligations?.perTargetRunModes === true;
}

function finalizeRow(seed) {
  const row = {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    ...seed,
  };
  row.coverageObligations = normalizeCoverageObligations(row);
  row.validationTargetScope = firstText(
    row.validationTargetScope,
    row.validation_target_scope,
  ) ?? (row.coverageObligations.perTargetRunModes ? 'run_mode_target' : 'evidence_row');
  const safetyFailures = rowSafetyFailures(row);
  row.safety = {
    accepted: safetyFailures.length === 0,
    failedGates: safetyFailures,
  };
  row.rowId = proofIdFor('gpu-validation-matrix-row', {
    ...row,
    rowId: undefined,
  });
  row.matrixKey = rowKey(row);
  return row;
}

function nativeBoundaryRequiresRealRocmAppHook({
  nativeRocmLaunchBoundary = {},
  realRocmRuntimeEligibility = {},
} = {}) {
  const nativeBoundaryGaps = compactStringList([
    ...(Array.isArray(nativeRocmLaunchBoundary.blockingGaps) ? nativeRocmLaunchBoundary.blockingGaps : []),
    ...(Array.isArray(nativeRocmLaunchBoundary.blocking_gaps) ? nativeRocmLaunchBoundary.blocking_gaps : []),
  ]);
  const runtimeEligibilityGaps = compactStringList([
    ...(Array.isArray(realRocmRuntimeEligibility.blockingGaps) ? realRocmRuntimeEligibility.blockingGaps : []),
    ...(Array.isArray(realRocmRuntimeEligibility.blocking_gaps) ? realRocmRuntimeEligibility.blocking_gaps : []),
  ]);
  return compactStringList([
    ...nativeBoundaryGaps,
    ...runtimeEligibilityGaps,
    nativeRocmLaunchBoundary.adapterOutcome,
    nativeRocmLaunchBoundary.adapter_outcome,
    nativeRocmLaunchBoundary.status,
    realRocmRuntimeEligibility.appHookContractStatus,
    realRocmRuntimeEligibility.app_hook_contract_status,
  ]).some((value) =>
    value === 'adapter_impossible_requires_app_hook'
    || value === 'app_hook_contract_not_declared'
    || value === 'required_app_hook_contract_missing'
    || /^app_hook_/.test(value)
  );
}

function realRocmAppHookContractGate({
  nativeBoundaryRequiresAppHook = false,
  nativeRocmLaunchBoundary = {},
  realRocmRuntimeEligibility = {},
  realRocmAppHookContract = {},
  realRocmProfileProofObligations = {},
  realRocmProfile = {},
} = {}) {
  const contract = compactObject(realRocmAppHookContract);
  const profile = compactObject(realRocmProfile);
  const profileProofObligations = compactObject(realRocmProfileProofObligations);
  const facetPresent = Object.keys(contract).length > 0;
  const profileAppHookContract = compactObject(profile.appHookContract ?? profile.app_hook_contract);
  const required =
    nativeBoundaryRequiresAppHook
    || nativeBoundaryRequiresRealRocmAppHook({
      nativeRocmLaunchBoundary,
      realRocmRuntimeEligibility,
    })
    || contract.required === true
    || contract.appHookRequired === true
    || contract.app_hook_required === true
    || profileProofObligations.requiresAppHookContract === true
    || profileProofObligations.requires_app_hook_contract === true
    || profileProofObligations.appHookContractRequired === true
    || profileProofObligations.app_hook_contract_required === true
    || profile.appHookContractDeclared === true
    || profile.app_hook_contract_declared === true
    || profileAppHookContract.declared === true
    || profileAppHookContract.required === true;
  const proven =
    facetPresent
    && (
      contract.canSatisfyRuntimeProof === true
      || contract.can_satisfy_runtime_proof === true
    );
  return {
    required,
    facetPresent,
    proven,
    accepted: !required || proven,
    missing: required && !facetPresent,
    failedGaps: compactStringList([
      required && !facetPresent ? 'real_rocm_app_hook_contract_missing' : null,
      required && !proven ? 'real_rocm_app_hook_contract_required' : null,
    ]),
  };
}

function realRocmRuntimeCapabilityPreflightFacet(input = {}) {
  const raw = compactObject(input);
  if (Object.keys(raw).length === 0) {
    return {
      present: false,
      accepted: null,
      blockingGaps: [],
      blocking_gaps: [],
    };
  }
  const deviceCount = finiteNumber(raw.deviceCount ?? raw.device_count);
  const deviceCountResult = finiteNumber(raw.deviceCountResult ?? raw.device_count_result);
  const allocationResult = finiteNumber(raw.allocationResult ?? raw.allocation_result);
  const exitCode = finiteNumber(raw.exitCode ?? raw.exit_code);
  const allocationMatrixFailureCount = finiteNumber(
    raw.allocationMatrixFailureCount ?? raw.allocation_matrix_failure_count,
  );
  const allocationMatrixTotal = finiteNumber(raw.allocationMatrixTotal ?? raw.allocation_matrix_total);
  const textureResourceMatrixFailureCount = finiteNumber(
    raw.textureResourceMatrixFailureCount ?? raw.texture_resource_matrix_failure_count,
  );
  const textureResourceMatrixTotal = finiteNumber(
    raw.textureResourceMatrixTotal ?? raw.texture_resource_matrix_total,
  );
  const allocationUnavailable = firstBool(raw.allocationUnavailable, raw.allocation_unavailable);
  const allocationAvailable =
    firstBool(raw.allocationAvailable, raw.allocation_available)
    ?? (allocationUnavailable === true ? false : null);
  const anyAllocationAvailable = firstBool(raw.anyAllocationAvailable, raw.any_allocation_available);
  const textureResourceFallbackAvailable = firstBool(
    raw.textureResourceFallbackAvailable,
    raw.texture_resource_fallback_available,
  );
  const degradedState = firstText(raw.degradedState, raw.degraded_state);
  const degradedReason = firstText(raw.degradedReason, raw.degraded_reason, raw.reason);
  const deviceCountError = firstText(raw.deviceCountError, raw.device_count_error);
  const allocationError = firstText(raw.allocationError, raw.allocation_error);
  const noDeviceEvidence = /no\s+(?:rocm-capable\s+)?device/i.test(
    compactStringList([deviceCountError, allocationError, degradedReason]).join(' '),
  );
  const allAllocationMatrixFailed =
    allocationMatrixTotal !== null
    && allocationMatrixTotal > 0
    && allocationMatrixFailureCount === allocationMatrixTotal;
  const allTextureMatrixFailed =
    textureResourceMatrixTotal !== null
    && textureResourceMatrixTotal > 0
    && textureResourceMatrixFailureCount === textureResourceMatrixTotal;
  const blockingGaps = compactStringList([
    degradedState,
    noDeviceEvidence ? 'runtime_device_unavailable' : null,
    deviceCount === 0 ? 'runtime_device_count_zero' : null,
    deviceCountResult !== null && deviceCountResult !== 0 ? 'runtime_device_count_probe_failed' : null,
    allocationResult !== null && allocationResult !== 0 ? 'runtime_array_allocation_probe_failed' : null,
    allocationAvailable === false ? 'runtime_array_allocation_unavailable' : null,
    anyAllocationAvailable === false ? 'runtime_any_array_allocation_unavailable' : null,
    allAllocationMatrixFailed ? 'runtime_array_allocation_matrix_failed' : null,
    textureResourceFallbackAvailable === false ? 'runtime_texture_fallback_unavailable' : null,
    allTextureMatrixFailed ? 'runtime_texture_resource_matrix_failed' : null,
    exitCode !== null && exitCode !== 0 ? 'runtime_capability_preflight_failed' : null,
  ]);
  const accepted = blockingGaps.length === 0;
  const status = accepted
    ? 'runtime_capability_preflight_observed'
    : firstText(
      degradedState,
      noDeviceEvidence ? 'runtime_device_unavailable' : null,
      allocationAvailable === false || anyAllocationAvailable === false
        ? 'runtime_array_allocation_unavailable'
        : null,
      'runtime_capability_preflight_failed',
    );
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_capability_preflight_facet.v1',
    present: true,
    accepted,
    status,
    proofAuthority: 'runtime_capability_preflight_evidence_only_not_gpu_hmr_success',
    proof_authority: 'runtime_capability_preflight_evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    backend: firstText(raw.backend),
    api: firstText(raw.api),
    probe: firstText(raw.probe),
    deviceCount,
    device_count: deviceCount,
    deviceCountResult,
    device_count_result: deviceCountResult,
    deviceCountError: deviceCountError ?? null,
    device_count_error: deviceCountError ?? null,
    allocationAvailable,
    allocation_available: allocationAvailable,
    anyAllocationAvailable,
    any_allocation_available: anyAllocationAvailable,
    allocationResult,
    allocation_result: allocationResult,
    allocationError: allocationError ?? null,
    allocation_error: allocationError ?? null,
    textureResourceFallbackAvailable,
    texture_resource_fallback_available: textureResourceFallbackAvailable,
    exitCode,
    exit_code: exitCode,
    degradedState: degradedState ?? null,
    degraded_state: degradedState ?? null,
    degradedReason: degradedReason ?? null,
    degraded_reason: degradedReason ?? null,
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
}

function runtimeCapabilityPreflightDirect(value) {
  const source = compactObject(value);
  return compactObject(source.runtime_capability_preflight ?? source.runtimeCapabilityPreflight);
}

function runtimeCapabilityPreflightFromOriginalHostProof(value) {
  const source = compactObject(value);
  const originalHostPathProof = compactObject(source.original_host_path_proof ?? source.originalHostPathProof);
  return runtimeCapabilityPreflightDirect(originalHostPathProof);
}

function runtimeCapabilityPreflightFromEvidence(value) {
  const source = compactObject(value);
  const evidence = source.evidence ?? source.evidence_refs ?? source.evidenceRefs;
  const evidenceItems = Array.isArray(evidence) ? evidence : [evidence];
  for (const item of evidenceItems) {
    const direct = runtimeCapabilityPreflightDirect(item);
    if (Object.keys(direct).length > 0) return direct;
    const originalHost = runtimeCapabilityPreflightFromOriginalHostProof(item);
    if (Object.keys(originalHost).length > 0) return originalHost;
  }
  return {};
}

function runtimeCapabilityPreflightFromSources({
  json,
  summary,
  runtimeProofArtifact,
}) {
  const candidates = [
    runtimeCapabilityPreflightDirect(json),
    runtimeCapabilityPreflightFromEvidence(json),
    runtimeCapabilityPreflightDirect(summary),
    runtimeCapabilityPreflightFromEvidence(summary),
    runtimeCapabilityPreflightDirect(runtimeProofArtifact),
    runtimeCapabilityPreflightFromEvidence(runtimeProofArtifact),
    runtimeCapabilityPreflightFromOriginalHostProof(json),
    runtimeCapabilityPreflightFromOriginalHostProof(summary),
    runtimeCapabilityPreflightFromOriginalHostProof(runtimeProofArtifact),
  ];
  return candidates.find((candidate) => Object.keys(candidate).length > 0) ?? {};
}

function rowSafetyFailures(row) {
  const failures = [];
  if (row.acceptedForGpuHmr === true && row.matrixOutcome !== 'full_runtime_gpu_hmr') {
    failures.push({ code: 'gpu_hmr_success_requires_full_runtime_outcome' });
  }
  if (row.acceptedForGpuHmr === true && row.proofChainAccepted !== true) {
    failures.push({ code: 'gpu_hmr_success_requires_accepted_proof_chain' });
  }
  if (row.acceptedForGpuHmr === true && row.cpuHmrUsed !== false) {
    failures.push({
      code: row.cpuHmrUsed === true
        ? 'gpu_hmr_success_cannot_use_cpu_hmr'
        : 'gpu_hmr_success_requires_cpu_hmr_false',
    });
  }
  if (row.acceptedForGpuHmr === true && row.fullRebuildUsed !== false) {
    failures.push({
      code: row.fullRebuildUsed === true
        ? 'gpu_hmr_success_cannot_use_full_rebuild'
        : 'gpu_hmr_success_requires_full_rebuild_false',
    });
  }
  if (row.acceptedForGpuHmr === true && row.processRestarted !== false) {
    failures.push({
      code: row.processRestarted === true
        ? 'gpu_hmr_success_cannot_restart_process'
        : 'gpu_hmr_success_requires_process_restart_false',
    });
  }
  if (row.acceptedForGpuHmr === true && row.visual?.required === true && row.visual.accepted !== true) {
    failures.push({ code: 'visual_gpu_hmr_success_requires_readable_visual_artifacts' });
  }
  if (
    row.acceptedForGpuHmr === true
    && (row.proofMode === 'run_mode_proof' || row.proofMode === 'real_rocm_repo_validation')
  ) {
    if (row.ledger?.present !== true) {
      failures.push({ code: 'gpu_hmr_success_requires_embedded_proof_ledger' });
    }
    if (row.ledger?.source !== 'recomputed_ledger') {
      failures.push({ code: 'gpu_hmr_success_requires_recomputed_proof_ledger' });
    }
    if (row.ledger?.gpuHmrSuccess !== true) {
      failures.push({ code: 'gpu_hmr_success_requires_ledger_success' });
    }
    if (Array.isArray(row.ledger?.failedInvariants) && row.ledger.failedInvariants.length > 0) {
      failures.push({ code: 'gpu_hmr_success_requires_zero_ledger_invariants' });
    }
    if (row.runtimeProofArtifact?.accepted !== true) {
      failures.push({ code: 'gpu_hmr_success_requires_strict_runtime_proof_artifact' });
    }
  }
  if (row.acceptedForGpuHmr === true && row.proofMode === 'real_rocm_repo_validation') {
    const appHookGate = realRocmAppHookContractGate({
      nativeRocmLaunchBoundary: compactObject(row.nativeRocmLaunchBoundary ?? row.native_rocm_launch_boundary),
      realRocmRuntimeEligibility: compactObject(row.realRocmRuntimeEligibility ?? row.real_rocm_runtime_eligibility),
      realRocmAppHookContract: compactObject(
        row.realRocmAppHookContract
        ?? row.real_rocm_app_hook_contract
        ?? row.appHookContract
        ?? row.app_hook_contract,
      ),
      realRocmProfileProofObligations: compactObject(
        row.realRocmProfileProofObligations
        ?? row.real_rocm_profile_proof_obligations
        ?? row.profileProofObligations
        ?? row.profile_proof_obligations,
      ),
      realRocmProfile: compactObject(
        row.realRocmProfile
        ?? row.real_rocm_profile
        ?? row.profile
        ?? row.realRocm
        ?? row.real_rocm,
      ),
    });
    if (appHookGate.required && !appHookGate.proven) {
      failures.push({
        code: appHookGate.missing
          ? 'gpu_hmr_success_requires_real_rocm_app_hook_contract'
          : 'gpu_hmr_success_requires_proven_real_rocm_app_hook_contract',
      });
    }
    const runtimeCapabilityPreflight = compactObject(
      row.realRocmRuntimeCapabilityPreflight
      ?? row.real_rocm_runtime_capability_preflight
      ?? row.runtimeCapabilityPreflight
      ?? row.runtime_capability_preflight,
    );
    if (runtimeCapabilityPreflight.present === true && runtimeCapabilityPreflight.accepted === false) {
      failures.push({
        code: 'gpu_hmr_success_cannot_have_failed_real_rocm_runtime_capability_preflight',
      });
    }
  }
  if (row.matrixOutcome === 'refusal_proven' && row.acceptedForGpuHmr === true) {
    failures.push({ code: 'refusal_row_cannot_accept_gpu_hmr' });
  }
  if (row.matrixOutcome === 'preflight_only' && row.acceptedForGpuHmr === true) {
    failures.push({ code: 'preflight_only_row_cannot_accept_gpu_hmr' });
  }
  return failures;
}

function ledgerFacet(json) {
  const ledger = compactObject(json.proofLedger ?? json.proof_ledger);
  const suppliedQuery = compactObject(json.proofLedgerQuery ?? json.proof_ledger_query ?? ledger.query);
  let query = null;
  let source = 'missing';
  if (Object.keys(ledger).length > 0) {
    query = queryGpuHmrLedgerInvariants(ledger);
    source = 'recomputed_ledger';
  } else if (suppliedQuery.schemaVersion || suppliedQuery.schema_version) {
    source = 'supplied_query_ignored_no_ledger';
  }
  const failures = Array.isArray(query?.failedInvariants)
    ? query.failedInvariants
    : Array.isArray(query?.failed_invariants)
      ? query.failed_invariants
      : [];
  return {
    present: Object.keys(ledger).length > 0,
    source,
    suppliedQueryPresent: Object.keys(suppliedQuery).length > 0,
    proofId: firstText(ledger.proofId, ledger.proof_id),
    gpuHmrSuccess: boolOrNull(query?.gpuHmrSuccess ?? query?.gpu_hmr_success),
    failedInvariants: failures.map((failure) => (
      isObject(failure) ? failure : { code: String(failure) }
    )),
    invariantSummary: compactObject(query?.invariantSummary ?? query?.invariant_summary),
    invariant_summary: compactObject(query?.invariantSummary ?? query?.invariant_summary),
    record: compactObject(query?.record),
  };
}

function runtimeProofArtifactFromValue(json) {
  return compactObject(
    json.runtimeProofArtifact
      ?? json.runtime_proof_artifact
      ?? json.validationRuntimeProofArtifact
      ?? json.validation_runtime_proof_artifact
      ?? json.gpuHmrRuntimeProofArtifact
      ?? json.gpu_hmr_runtime_proof_artifact
      ?? json.gpuRuntimeProofArtifact
      ?? json.gpu_runtime_proof_artifact,
  );
}

function runModeLedgerFacet(json, runtimeProofArtifact) {
  return ledgerFacet({
    proofLedger:
      json.proofLedger
      ?? json.proof_ledger
      ?? runtimeProofArtifact.proofLedger
      ?? runtimeProofArtifact.proof_ledger,
    proofLedgerQuery:
      json.proofLedgerQuery
      ?? json.proof_ledger_query
      ?? runtimeProofArtifact.proofLedgerQuery
      ?? runtimeProofArtifact.proof_ledger_query,
  });
}

function runtimeProofArtifactFacet(runtimeProofArtifact) {
  const present = Object.keys(runtimeProofArtifact).length > 0;
  const gate = runtimeProofArtifactStrictGate(
    present ? runtimeProofArtifact : null,
    { name: 'run_mode_runtime_proof_artifact' },
  );
  return {
    present,
    proofId: firstText(runtimeProofArtifact.proofId, runtimeProofArtifact.proof_id),
    accepted: gate.accepted === true,
    source: present ? 'embedded_runtime_proof_artifact' : 'missing',
    failedGates: compactStringList(gate.failures).map((code) => ({ code })),
  };
}

function proofIdsFrom(...values) {
  return compactStringList(values.flatMap((value) => {
    if (!value) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap((item) => proofIdsFrom(item));
    if (!isObject(value)) return [];
    return [
      value.proofId,
      value.proof_id,
      value.runtimeProof?.proofId,
      value.runtimeProof?.proof_id,
      value.proofLedger?.proofId,
      value.proof_ledger?.proofId,
      value.proof_ledger?.proof_id,
      value.proofLedgerQuery?.proofId,
      value.proof_ledger_query?.proofId,
      value.rejectionProofArtifact?.proofId,
      value.visualProofArtifact?.proofId,
    ];
  }));
}

function artifactPathsFromValue(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => artifactPathsFromValue(item));
  if (!isObject(value)) return [];
  return compactStringList([
    value.path,
    value.summary,
    value.before_image,
    value.after_image,
    value.diff_image,
    value.beforeImage,
    value.afterImage,
    value.diffImage,
    value.rendered_card_png,
    value.renderedCardPng,
    ...Object.values(value).flatMap((item) => (
      isObject(item) || Array.isArray(item) ? artifactPathsFromValue(item) : []
    )),
  ]);
}

async function runtimeProofRow(json, filePath, context) {
  const contract = compactObject(json.acceptanceContract ?? json.acceptance_contract);
  const classification = compactObject(contract.classification);
  const artifactIdentity = compactObject(contract.artifact_identity ?? contract.artifactIdentity);
  const ledger = ledgerFacet(json);
  const resultState = firstText(json.resultState, json.result_state);
  const accepted =
    json.gpuHmrSuccess === true
    && json.fullRuntimeProven === true
    && resultState === 'gpu-hmr-full-runtime-proven'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0;
  const backend = firstText(
    isObject(contract.backend) ? contract.backend.value : contract.backend,
    json.backend,
  ) ?? 'unknown';
  const targetId = firstText(
    json.target_name,
    json.targetName,
    artifactIdentity.entry_points?.join('+'),
    contract.project_id,
    contract.projectId,
    json.workspaceSlug,
    json.workspace_slug,
  );
  const ledgerRecord = compactObject(json.proofLedger?.records?.[0] ?? json.proof_ledger?.records?.[0]);
  const oracleArtifacts = compactObject(ledgerRecord.oracle_artifacts ?? ledgerRecord.oracleArtifacts);
  const hasVisualOracle = isObject(oracleArtifacts.visual_oracle_artifacts ?? oracleArtifacts.visualOracleArtifacts);
  const hasComputeOracle = isObject(oracleArtifacts.compute_oracle_artifacts ?? oracleArtifacts.computeOracleArtifacts);
  const outputKind = hasVisualOracle ? 'visual_oracle' : hasComputeOracle ? 'compute_oracle' : 'compute_oracle';
  const runMode = timingEvidence(
    ledgerRecord,
    json.timingMetrics,
    json.timing_metrics,
    json.timings,
  );
  const derivedProofLedgerRecord = compactObject(
    json.derivedProofLedgerRecord ?? json.derived_proof_ledger_record,
  );
  const ledgerInvariantSummary = compactObject(ledger.invariantSummary ?? ledger.invariant_summary);
  const ledgerNormalizedRecord = compactObject(ledger.record);
  const cpuHmrUsed = firstBool(
    derivedProofLedgerRecord.cpuHmrUsed,
    derivedProofLedgerRecord.cpu_hmr_used,
    ledgerInvariantSummary.cpuHmrUsed,
    ledgerInvariantSummary.cpu_hmr_used,
    ledgerNormalizedRecord.cpuHmrUsed,
    ledgerNormalizedRecord.cpu_hmr_used,
  );
  const fullRebuildUsed = firstBool(
    derivedProofLedgerRecord.fullRebuildUsed,
    derivedProofLedgerRecord.full_rebuild_used,
    ledgerInvariantSummary.fullRebuildUsed,
    ledgerInvariantSummary.full_rebuild_used,
    ledgerNormalizedRecord.fullRebuildUsed,
    ledgerNormalizedRecord.full_rebuild_used,
  );
  const processRestarted = firstBool(
    derivedProofLedgerRecord.processRestarted,
    derivedProofLedgerRecord.process_restarted,
    ledgerInvariantSummary.processRestarted,
    ledgerInvariantSummary.process_restarted,
    ledgerNormalizedRecord.processRestarted,
    ledgerNormalizedRecord.process_restarted,
  );
  const visualPaths = compactStringList([
    ...artifactPathsFromValue(json.visualEvidenceArtifacts ?? json.visual_evidence_artifacts),
    ...artifactPathsFromValue(json.visualEvidenceRefs ?? json.visual_evidence_refs),
    ...artifactPathsFromValue(
      oracleArtifacts.visual_oracle_artifacts
      ?? oracleArtifacts.visualOracleArtifacts
      ?? oracleArtifacts.compute_oracle_artifacts
      ?? oracleArtifacts.computeOracleArtifacts,
    ).filter((item) => item.endsWith('.png')),
  ]);
  const visual = await visualArtifactEvidence(visualPaths, context.repoRoot, path.dirname(filePath), {}, outputKind === 'visual_oracle');
  return finalizeRow({
    artifactSchema: json.schemaVersion,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId,
    profileId: targetId,
    proofMode: 'strict_runtime_ledger',
    evidenceKind: outputKind,
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : 'unproven',
    acceptanceClass: accepted ? 'full_runtime_gpu_hmr' : 'runtime_proof_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'proof_ledger_invariant_query' : 'proof_ledger_rejected',
    proofIds: proofIdsFrom(json, ledger),
    ledger,
    visual,
    runMode,
    cpuHmrUsed,
    fullRebuildUsed,
    processRestarted,
    reasons: accepted ? [] : compactStringList([
      json.degradedReason,
      ...(Array.isArray(json.limitations) ? json.limitations.map((item) => item?.degradedReason ?? item?.degraded_reason ?? item) : []),
      ...ledger.failedInvariants.map((failure) => failure.code),
    ]),
    openGaps: accepted ? [] : ['runtime_proof_not_accepted'],
    classification: {
      projectKind: firstText(classification.project_kind, classification.projectKind),
      editKind: firstText(classification.edit_kind, classification.editKind),
      route: firstText(classification.route),
    },
  });
}

function parseRecordDetailJson(record) {
  try {
    return JSON.parse(record?.detail ?? '{}');
  } catch {
    return null;
  }
}

function detailRecord(records, name, fromEnd = true) {
  const matches = records.filter((record) => record?.name === name);
  if (matches.length === 0) return null;
  return fromEnd ? matches[matches.length - 1] : matches[0];
}

function detailStatus(records, name) {
  return detailRecord(records, name)?.status ?? null;
}

function imagePathsFromDetail(detail) {
  const raw = text(detail);
  if (!raw) return [];
  const imageMatch = raw.match(/images=([^ ]+)/);
  const diffMatch = raw.match(/diff=([^ ]+)/);
  return compactStringList([
    ...(imageMatch ? imageMatch[1].split(',') : []),
    ...(diffMatch ? [diffMatch[1]] : []),
  ]);
}

function visualMetricsFromDeltaDetail(detail) {
  const raw = text(detail) ?? '';
  return {
    changedPixelRatio: finiteNumber(raw.match(/changed=([0-9.]+)%/)?.[1]) !== null
      ? finiteNumber(raw.match(/changed=([0-9.]+)%/)?.[1]) / 100
      : null,
    meanAbsDelta8bit: finiteNumber(raw.match(/mean_abs=([0-9.]+)/)?.[1]),
    selectedDeltaMs: finiteNumber(raw.match(/selected_delta_ms=([0-9.]+)/)?.[1]),
  };
}

function backendFromVendorText(value) {
  const raw = String(value ?? '').toLowerCase();
  if (/\b(rocm|amd|hip)\b/.test(raw)) return 'hip';
  if (/\bcuda\b/.test(raw)) return 'cuda';
  if (/\bopencl\b/.test(raw)) return 'opencl';
  if (/\bvulkan\b/.test(raw)) return 'vulkan';
  if (/\bwebgpu\b/.test(raw)) return 'webgpu';
  if (/\bbevy_wgsl\b/.test(raw)) return 'bevy_wgsl';
  return null;
}

function runtimePayloadIdentity(value) {
  const contract = compactObject(
    value?.acceptanceContract
      ?? value?.acceptance_contract
      ?? value?.contract,
  );
  const artifactIdentity = compactObject(contract.artifact_identity ?? contract.artifactIdentity);
  const backend = firstText(
    isObject(contract.backend) ? contract.backend.value : contract.backend,
    value?.backend,
  );
  const targetId = firstText(
    value?.targetId,
    value?.target_id,
    value?.targetName,
    value?.target_name,
    contract.project_id,
    contract.projectId,
    artifactIdentity.source_paths?.join('+'),
    artifactIdentity.sourcePaths?.join('+'),
    artifactIdentity.entry_points?.join('+'),
    artifactIdentity.entryPoints?.join('+'),
  );
  const profileId = firstText(
    value?.profileId,
    value?.profile_id,
    contract.contract_id,
    contract.contractId,
    targetId,
  );
  return {
    backend: backend ?? 'unknown',
    targetId: targetId ?? 'unknown',
    profileId: profileId ?? targetId ?? 'unknown',
  };
}

function acceptedLedgerValidation(proofValidation) {
  const ledgerValidation = compactObject(proofValidation?.proofLedgerValidation);
  return proofValidation?.satisfied === true
    && ledgerValidation.gpuHmrSuccess === true
    && Array.isArray(ledgerValidation.failedInvariants)
    && ledgerValidation.failedInvariants.length === 0;
}

function firewallFieldsFromProofValidation(proofValidation) {
  if (!acceptedLedgerValidation(proofValidation)) {
    return {
      cpuHmrUsed: null,
      fullRebuildUsed: null,
      processRestarted: null,
      firewallEvidenceSource: 'missing_accepted_proof_ledger_validation',
    };
  }
  return {
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: false,
    firewallEvidenceSource: 'proof_ledger_invariant_query',
  };
}

function hasOwnValue(object, key) {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function firstOwnBool(object, keys) {
  for (const key of keys) {
    if (hasOwnValue(object, key) && typeof object[key] === 'boolean') {
      return { present: true, value: object[key] };
    }
  }
  return { present: false, value: null };
}

function firstRecordedEvidence(object, keys) {
  for (const key of keys) {
    if (!hasOwnValue(object, key)) continue;
    const value = object[key];
    if (value === true) return true;
    if (typeof value === 'string' && value.trim()) return true;
    if (typeof value === 'number' && Number.isFinite(value)) return true;
    if (Array.isArray(value) && value.length > 0) return true;
    if (isObject(value) && Object.keys(value).length > 0) return true;
  }
  return false;
}

function realRocmFirewallCandidate(object, source, valueKeys, evidenceKeys, trustedFalse = false) {
  const found = firstOwnBool(object, valueKeys);
  if (!found.present) return null;
  const evidencePresent =
    found.value === true
    || trustedFalse
    || firstRecordedEvidence(object, evidenceKeys);
  if (!evidencePresent) return null;
  return {
    value: found.value,
    source,
    evidencePresent,
  };
}

function firstRealRocmFirewallFact(candidates, valueKeys, evidenceKeys) {
  for (const candidate of candidates) {
    const fact = realRocmFirewallCandidate(
      candidate.object,
      candidate.source,
      valueKeys,
      evidenceKeys,
      candidate.trustedFalse === true,
    );
    if (fact) return fact;
  }
  return { value: null, source: 'missing', evidencePresent: false };
}

function realRocmFirewallFieldsFromEvidence({
  json = {},
  summary = {},
  runtimeProofArtifact = {},
  proofLedger = {},
} = {}) {
  const proofLedgerQuery = Object.keys(proofLedger).length > 0
    ? queryGpuHmrLedgerInvariants(proofLedger)
    : null;
  const invariantSummary = compactObject(proofLedgerQuery?.invariantSummary);
  const ledgerRecord = compactObject(proofLedgerQuery?.record);
  const candidates = [
    {
      object: invariantSummary,
      source: 'proof_ledger_invariant_summary',
      trustedFalse: proofLedgerQuery?.gpuHmrSuccess === true,
    },
    {
      object: ledgerRecord,
      source: 'proof_ledger_record',
      trustedFalse: proofLedgerQuery?.gpuHmrSuccess === true,
    },
    {
      object: compactObject(
        runtimeProofArtifact.derivedProofLedgerRecord
        ?? runtimeProofArtifact.derived_proof_ledger_record,
      ),
      source: 'runtime_proof_artifact_derived_proof_ledger_record',
    },
    {
      object: compactObject(proofLedger.record ?? proofLedger.proof_record),
      source: 'proof_ledger_record_alias',
    },
    {
      object: compactObject(runtimeProofArtifact.firewallEvidence ?? runtimeProofArtifact.firewall_evidence),
      source: 'runtime_proof_artifact_firewall_evidence',
    },
    {
      object: compactObject(summary.firewallEvidence ?? summary.firewall_evidence),
      source: 'summary_firewall_evidence',
    },
    {
      object: compactObject(json.firewallEvidence ?? json.firewall_evidence),
      source: 'artifact_firewall_evidence',
    },
    {
      object: runtimeProofArtifact,
      source: 'runtime_proof_artifact_top_level',
    },
    {
      object: summary,
      source: 'summary_top_level',
    },
    {
      object: json,
      source: 'artifact_top_level',
    },
  ];
  const commonEvidenceKeys = [
    'evidence_source',
    'evidenceSource',
    'source',
    'proofAuthority',
    'proof_authority',
    'evidence_refs',
    'evidenceRefs',
  ];
  const cpu = firstRealRocmFirewallFact(
    candidates,
    ['cpuHmrUsed', 'cpu_hmr_used'],
    [
      'cpuHmrUsedEvidencePresent',
      'cpu_hmr_used_evidence_present',
      'cpuHmrAbsenceBasis',
      'cpu_hmr_absence_basis',
      ...commonEvidenceKeys,
    ],
  );
  const full = firstRealRocmFirewallFact(
    candidates,
    ['fullRebuildUsed', 'full_rebuild_used'],
    [
      'fullRebuildUsedEvidencePresent',
      'full_rebuild_used_evidence_present',
      'fullRebuildAbsenceBasis',
      'full_rebuild_absence_basis',
      ...commonEvidenceKeys,
    ],
  );
  const process = firstRealRocmFirewallFact(
    candidates,
    ['processRestarted', 'process_restarted'],
    [
      'processRestartedEvidencePresent',
      'process_restarted_evidence_present',
      'processRestartAbsenceBasis',
      'process_restart_absence_basis',
      'processRestartObserved',
      'process_restart_observed',
      'hostRestartCount',
      'host_restart_count',
      'runtimeIdentityChanges',
      'runtime_identity_changes',
      ...commonEvidenceKeys,
    ],
  );
  const failedGates = compactStringList([
    cpu.value === true ? 'cpu_hmr_used_by_real_rocm_firewall' : null,
    cpu.value === false ? null : cpu.value === null ? 'cpu_hmr_absence_evidence_required' : null,
    full.value === true ? 'full_rebuild_used_by_real_rocm_firewall' : null,
    full.value === false ? null : full.value === null ? 'full_rebuild_absence_evidence_required' : null,
    process.value === true ? 'process_restart_observed_by_real_rocm_firewall' : null,
    process.value === false ? null : process.value === null ? 'process_restart_absence_evidence_required' : null,
  ]).map((code) => ({ code }));
  const evidenceSources = compactStringList([cpu.source, full.source, process.source]);
  return {
    accepted: cpu.value === false && full.value === false && process.value === false,
    cpuHmrUsed: cpu.value,
    cpu_hmr_used: cpu.value,
    fullRebuildUsed: full.value,
    full_rebuild_used: full.value,
    processRestarted: process.value,
    process_restarted: process.value,
    cpuHmrEvidenceSource: cpu.source,
    cpu_hmr_evidence_source: cpu.source,
    fullRebuildEvidenceSource: full.source,
    full_rebuild_evidence_source: full.source,
    processRestartEvidenceSource: process.source,
    process_restart_evidence_source: process.source,
    firewallEvidenceSource: evidenceSources.join('+') || 'missing',
    firewall_evidence_source: evidenceSources.join('+') || 'missing',
    failedGates,
    failed_gates: failedGates,
  };
}

async function agentSplitRow(records, filePath, context) {
  const waitDetail = parseRecordDetailJson(detailRecord(records, 'mcp wait_hmr proof gate'));
  const proofValidation = compactObject(waitDetail?.gpu_proof_validation);
  const ledgerValidation = compactObject(proofValidation.proofLedgerValidation);
  const runtimeValidation = compactObject(proofValidation.runtimeProofArtifactValidation);
  const identity = runtimePayloadIdentity(waitDetail);
  const backend = backendFromVendorText(detailRecord(records, 'gpu vendor', false)?.detail)
    ?? identity.backend;
  const firewall = firewallFieldsFromProofValidation(proofValidation);
  const deltaRecord = detailRecord(records, 'mcp screenshot visual delta');
  const deltaMetrics = visualMetricsFromDeltaDetail(deltaRecord?.detail);
  const beforePaths = imagePathsFromDetail(detailRecord(records, 'mcp screenshot before hmr')?.detail);
  const afterPaths = imagePathsFromDetail(detailRecord(records, 'mcp screenshot after hmr')?.detail);
  const diffPaths = imagePathsFromDetail(deltaRecord?.detail);
  const visual = await visualArtifactEvidence(
    [...beforePaths, ...afterPaths, ...diffPaths],
    context.repoRoot,
    path.dirname(filePath),
    deltaMetrics,
    true,
  );
  const accepted =
    detailStatus(records, 'worker used GPU split endpoint') === 'pass'
    && detailStatus(records, 'generated split contains HMR ABI') === 'pass'
    && detailStatus(records, 'generated split HMR granularity') === 'pass'
    && detailStatus(records, 'device-only GPU HMR observed') === 'pass'
    && detailStatus(records, 'runner stayed alive after GPU HMR') === 'pass'
    && proofValidation.satisfied === true
    && ledgerValidation.gpuHmrSuccess === true
    && Array.isArray(ledgerValidation.failedInvariants)
    && ledgerValidation.failedInvariants.length === 0
    && runtimeValidation.accepted === true
    && firewall.cpuHmrUsed === false
    && firewall.fullRebuildUsed === false
    && firewall.processRestarted === false
    && identity.targetId !== 'unknown'
    && deltaRecord?.status === 'pass'
    && visual.accepted === true;
  const ledger = {
    present: Boolean(ledgerValidation.proofId),
    proofId: firstText(ledgerValidation.proofId),
    gpuHmrSuccess: boolOrNull(ledgerValidation.gpuHmrSuccess),
    failedInvariants: Array.isArray(ledgerValidation.failedInvariants)
      ? ledgerValidation.failedInvariants
      : [],
  };
  const runMode = timingEvidence(
    waitDetail?.timingMetrics,
    waitDetail?.timing_metrics,
    waitDetail?.gpu_proof_telemetry,
    proofValidation,
  );
  return finalizeRow({
    artifactSchema: 'synthi.gpu.hmr.agent_split_results.v1',
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId: identity.targetId,
    profileId: identity.profileId,
    proofMode: 'mcp_preview_visual',
    evidenceKind: 'visual_oracle',
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : 'unproven',
    acceptanceClass: accepted ? 'full_runtime_gpu_hmr' : 'mcp_preview_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'mcp_wait_hmr_runtime_proof_gate' : 'mcp_wait_hmr_runtime_proof_gate_rejected',
    proofIds: proofIdsFrom(
      ledgerValidation.proofId,
      waitDetail?.gpu_proof_telemetry?.proofId,
      waitDetail?.gpu_proof_telemetry?.proof_id,
    ),
    ledger,
    visual,
    runMode,
    cpuHmrUsed: firewall.cpuHmrUsed,
    fullRebuildUsed: firewall.fullRebuildUsed,
    processRestarted: firewall.processRestarted,
    firewallEvidenceSource: firewall.firewallEvidenceSource,
    timings: {
      selectedDeltaMs: deltaMetrics.selectedDeltaMs,
    },
    reasons: accepted ? [] : compactStringList([
      proofValidation.reason,
      identity.targetId === 'unknown' ? 'target_identity_not_present_in_runtime_payload' : null,
      ...(Array.isArray(ledger.failedInvariants) ? ledger.failedInvariants.map((failure) => failure.code) : []),
      visual.accepted ? null : 'visual_artifacts_not_readable',
    ]),
    openGaps: accepted ? [] : ['mcp_runtime_visual_proof_not_accepted'],
  });
}

function backendFromGeneratedFissionReport(report) {
  const selectedPath = firstText(
    report.deterministicFissionVerifier?.selectedPath,
    report.deterministic_fission_verifier?.selectedPath,
    report.deterministic_fission_verifier?.selected_path,
    report.selectedIslandContract?.sourcePaths?.[0],
    report.selectedIslandContract?.source_paths?.[0],
  ) ?? '';
  const lower = selectedPath.toLowerCase();
  if (lower.endsWith('.hip')) return 'hip';
  if (lower.endsWith('.cu')) return 'cuda';
  if (lower.endsWith('.cl')) return 'opencl';
  if (lower.endsWith('.wgsl')) return 'webgpu';
  if (lower.endsWith('.spv') || lower.endsWith('.spirv')) return 'vulkan';
  return 'gpu_fission';
}

function generatedFissionCoverageAccepted(report, classifiedProof) {
  const verifier = compactObject(report.deterministicFissionVerifier ?? report.deterministic_fission_verifier);
  const fissionProof = compactObject(report.fissionProof ?? report.fission_proof);
  const selectedContracts = Array.isArray(fissionProof.selectedIslandContracts)
    ? fissionProof.selectedIslandContracts.filter(isObject)
    : [];
  const selectedContract = selectedContracts[0] ?? {};
  const coverage = compactObject(
    selectedContract.verificationEvidenceCoverage
    ?? selectedContract.verification_evidence_coverage
    ?? verifier.verificationEvidenceCoverage
    ?? verifier.verification_evidence_coverage,
  );
  const requiredCategories = compactStringList(coverage.requiredCategories ?? coverage.required_categories);
  const missingCategories = compactStringList(coverage.missingCategories ?? coverage.missing_categories);
  const categories = Array.isArray(coverage.categories) ? coverage.categories.filter(isObject) : [];
  const evidenceByCategory = new Map(categories.map((category) => [
    firstText(category.category),
    compactStringList(category.evidenceIds ?? category.evidence_ids),
  ]));
  const required = [
    'source_mapping',
    'include_closure',
    'symbol_ownership',
    'dependency_closure',
    'abi_membrane',
    'compile_recipe',
    'loader_capability',
    'output_oracle',
  ];
  return report.proofBoundary === 'deterministic_fission_verifier'
    && verifier.accepted === true
    && report.smallestSafeFissionIslandProven === true
    && report.perKernelHmrProven === true
    && report.acceptedClaim === 'per_kernel_hmr'
    && classifiedProof.fissionProven === true
    && selectedContracts.length === 1
    && missingCategories.length === 0
    && required.every((category) => requiredCategories.includes(category))
    && required.every((category) => (evidenceByCategory.get(category) ?? []).length > 0);
}

async function generatedSplitFissionRow(json, filePath, context) {
  const verifier = compactObject(json.deterministicFissionVerifier ?? json.deterministic_fission_verifier);
  const fissionProof = compactObject(json.fissionProof ?? json.fission_proof);
  const classifiedProof = classifyGpuHmrFissionProof(fissionProof);
  const accepted = generatedFissionCoverageAccepted(json, classifiedProof);
  const selectedPath = firstText(
    verifier.selectedPath,
    verifier.selected_path,
    json.selectedIslandContract?.sourcePaths?.[0],
    json.selectedIslandContract?.source_paths?.[0],
  );
  const selectedKernel = firstText(
    verifier.selectedKernel,
    verifier.selected_kernel,
    json.selectedIslandContract?.targetSymbols?.[0],
    json.selectedIslandContract?.target_symbols?.[0],
  );
  const verifierEvidenceId = firstText(
    verifier.verifierEvidenceId,
    verifier.verifier_evidence_id,
    fissionProof.verifierEvidenceRefs?.[0],
    fissionProof.verifier_evidence_refs?.[0],
  );
  return finalizeRow({
    artifactSchema: firstText(json.schemaVersion, json.schema),
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend: backendFromGeneratedFissionReport(json),
    targetId: firstText(selectedKernel, selectedPath) ?? 'unknown',
    profileId: firstText(selectedPath, selectedKernel) ?? 'unknown',
    proofMode: 'deterministic_fission_verifier',
    evidenceKind: 'fission_verifier_report',
    matrixOutcome: accepted ? 'deterministic_fission_proven' : 'unproven',
    acceptanceClass: accepted ? 'smallest_safe_per_kernel_fission' : 'fission_verifier_rejected',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'deterministic_fission_verifier' : 'deterministic_fission_verifier_rejected',
    proofIds: proofIdsFrom(
      verifierEvidenceId,
      fissionProof.evidenceRefs,
      fissionProof.verifierEvidenceRefs,
      fissionProof.deterministicVerifierEvidenceRefs,
    ),
    ledger: {
      present: false,
      proofId: null,
      gpuHmrSuccess: null,
      failedInvariants: [],
    },
    runMode: timingEvidence(json),
    visual: {
      required: false,
      present: false,
      accepted: true,
      imageCount: 0,
      existingImageCount: 0,
      pngImageCount: 0,
      allImagesExist: true,
      allImagesArePng: true,
      changedPixelRatio: null,
      meanAbsDelta8bit: null,
      visiblePixelCount: null,
      images: [],
    },
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: false,
    reasons: accepted ? [] : compactStringList([
      ...compactStringList(json.reasonCodes ?? json.reason_codes),
      classifiedProof.degradedReason,
      ...(Array.isArray(verifier.failures) ? verifier.failures : []),
    ]),
    openGaps: accepted ? [] : ['deterministic_fission_verifier_not_accepted'],
  });
}

async function hiprtWarmRow(json, filePath, context) {
  const acceptance = compactObject(json.acceptance);
  const diff = compactObject(json.diff);
  const oracleRegion = compactObject(diff.oracleRegion ?? diff.oracle_region);
  const baseline = compactObject(json.runtime?.baseline);
  const changed = compactObject(json.runtime?.changed);
  const strict = compactObject(json.strictHmrProvenance ?? json.strict_hmr_provenance);
  const runtimeProofArtifact = runtimeProofArtifactFromValue(json);
  const ledger = runModeLedgerFacet(json, runtimeProofArtifact);
  const runtimeProofArtifactProof = runtimeProofArtifactFacet(runtimeProofArtifact);
  const ledgerRecord = compactObject(
    json.proofLedger?.records?.[0]
    ?? json.proof_ledger?.records?.[0]
    ?? runtimeProofArtifact.proofLedger?.records?.[0]
    ?? runtimeProofArtifact.proof_ledger?.records?.[0],
  );
  const cpuHmrUsed = boolOrNull(ledgerRecord.cpu_hmr_used ?? ledgerRecord.cpuHmrUsed);
  const fullRebuildUsed = boolOrNull(ledgerRecord.full_rebuild_used ?? ledgerRecord.fullRebuildUsed);
  const processRestarted = boolOrNull(ledgerRecord.process_restarted ?? ledgerRecord.processRestarted);
  const baselineCapturePath = resolveEvidencePath(baseline.localCapturePath, context.repoRoot, path.dirname(filePath));
  const changedCapturePath = resolveEvidencePath(changed.localCapturePath, context.repoRoot, path.dirname(filePath));
  const oracleRegionRecomputed = await recomputeHiprtOracleRegion({
    baselinePath: baselineCapturePath,
    changedPath: changedCapturePath,
    oracleRegion,
  });
  const visual = await visualArtifactEvidence(
    [baseline.localCapturePath, changed.localCapturePath, diff.path],
    context.repoRoot,
    path.dirname(filePath),
    {
      changedPixelRatio: diff.changedPixelRatioThreshold4,
      meanAbsDelta8bit: diff.meanAbsDelta8bit,
    },
    true,
  );
  const oracleRegionAccepted =
    acceptance.oracleRegionNonBlank === true
    && oracleRegion.nonBlankAfterEpoch === true
    && oracleRegion.blankFrameRejected === true
    && oracleRegionRecomputed.accepted === true
    && oracleRegionRecomputed.nonBlankAfterEpoch === true
    && oracleRegionRecomputed.blankFrameRejected === true
    && finiteNumber(oracleRegion.changed?.visiblePixelRatio) > 0
    && finiteNumber(oracleRegion.changed?.visiblePixels) > 0;
  const accepted =
    json.accepted === true
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && runtimeProofArtifactProof.present === true
    && runtimeProofArtifactProof.accepted === true
    && acceptance.strictProvenance === true
    && acceptance.sameProcessRuntime === true
    && acceptance.visualDelta === true
    && oracleRegionAccepted === true
    && strict.fullRuntimeProven === true
    && strict.strictFullRuntimePassed === true
    && changed.sameProcess === true
    && visual.accepted === true;
  const blankRegionRefusal =
    json.accepted === false
    && acceptance.visualDelta === true
    && acceptance.oracleRegionNonBlank === false
    && oracleRegion.blankFrameRejected === false
    && oracleRegionRecomputed.present === true
    && oracleRegionRecomputed.nonBlankAfterEpoch === false
    && finiteNumber(oracleRegionRecomputed.changedPixelsThreshold4) > 0
    && finiteNumber(oracleRegion.changed?.visiblePixelRatio) !== null
    && finiteNumber(oracleRegion.changed?.visiblePixels) !== null;
  const profileId = firstText(json.profile?.id, json.profileId, json.slug);
  const runMode = timingEvidence(json.timingMetrics, json.timing_metrics, json.timings);
  return finalizeRow({
    artifactSchema: json.schemaVersion,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend: 'hiprt',
    targetId: profileId,
    profileId,
    proofMode: firstText(json.mode, 'same-process'),
    evidenceKind: 'raytraced_visual_oracle',
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : blankRegionRefusal ? 'refusal_proven' : 'unproven',
    acceptanceClass: accepted
      ? 'full_runtime_gpu_hmr'
      : blankRegionRefusal
        ? 'hiprt_visual_blank_region_refusal'
        : 'hiprt_runtime_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: blankRegionRefusal,
    proofChainAccepted: accepted || blankRegionRefusal,
    proofChain: accepted
      ? 'embedded_runtime_proof_artifact_recomputed_ledger'
      : blankRegionRefusal
        ? 'hiprt_oracle_region_blank_refusal'
        : 'hiprt_strict_runtime_rejected',
    proofIds: proofIdsFrom(json, strict, runtimeProofArtifact, ledger),
    ledger,
    runtimeProofArtifact: runtimeProofArtifactProof,
    oracleRegion: oracleRegionRecomputed,
    visual,
    runMode,
    cpuHmrUsed,
    fullRebuildUsed,
    processRestarted,
    timings: {
      totalWallMs: finiteNumber(json.timings?.totalWallMs),
      liveRecompileMs: finiteNumber(changed.liveRecompileMs),
      editToFirstVisualMs: finiteNumber(changed.totalHostWallMs),
    },
    reasons: accepted ? [] : compactStringList([
      visual.accepted ? null : 'visual_artifacts_not_readable',
      strict.fullRuntimeProven === true ? null : 'strict_full_runtime_not_proven',
      ledger.present === true ? null : 'proof_ledger_missing',
      ledger.source === 'recomputed_ledger' ? null : 'proof_ledger_not_recomputed',
      ledger.gpuHmrSuccess === true ? null : 'proof_ledger_gpu_hmr_success_not_true',
      ledger.failedInvariants.length === 0 ? null : 'proof_ledger_invariants_failed',
      runtimeProofArtifactProof.present === true ? null : 'runtime_proof_artifact_missing',
      runtimeProofArtifactProof.accepted === true ? null : 'runtime_proof_artifact_not_strictly_accepted',
      oracleRegionAccepted === true ? null : 'hiprt_oracle_region_nonblank_not_proven',
      oracleRegionRecomputed.accepted === true ? null : 'hiprt_oracle_region_pixel_recompute_not_accepted',
      cpuHmrUsed === false ? null : 'cpu_hmr_firewall_field_not_false',
      fullRebuildUsed === false ? null : 'full_rebuild_firewall_field_not_false',
      processRestarted === false ? null : 'process_restart_firewall_field_not_false',
      ...oracleRegionRecomputed.failedGates.map((failure) => failure.code),
    ]),
    openGaps: accepted
      ? []
      : blankRegionRefusal
        ? ['full_runtime_gpu_hmr_not_proven_blank_oracle_region']
        : ['hiprt_same_process_visual_proof_not_accepted'],
  });
}

async function webGpuRuntimeVisualRow(json, filePath, context) {
  const visualArtifacts = compactObject(
    json.visualOracleArtifacts
    ?? json.visual_oracle_artifacts
    ?? json.artifacts,
  );
  const metrics = compactObject(json.metrics);
  const visual = await visualArtifactEvidence(
    [visualArtifacts.beforeImage, visualArtifacts.afterImage, visualArtifacts.diffImage,
      visualArtifacts.before_image, visualArtifacts.after_image, visualArtifacts.diff_image],
    context.repoRoot,
    path.dirname(filePath),
    metrics,
    true,
  );
  const ledger = ledgerFacet(json);
  const ledgerRecord = compactObject(json.proofLedger?.records?.[0] ?? json.proof_ledger?.records?.[0]);
  const processContinuity = compactObject(json.browser?.processContinuity);
  const nativeApiEvidence = compactObject(json.nativeWebGpuApiEvidence);
  const contract = compactObject(json.contract ?? json.acceptanceContract ?? json.acceptance_contract);
  const webgpuContract = compactObject(contract.webgpu_contract ?? contract.webgpuContract);
  const runtimeResourceTrace = compactObject(
    webgpuContract.runtime_resource_trace
    ?? webgpuContract.runtimeResourceTrace
    ?? ledgerRecord.runtime_resource_trace
    ?? ledgerRecord.runtimeResourceTrace,
  );
  const supportedPipelineScope = firstText(
    webgpuContract.supported_pipeline_scope,
    webgpuContract.supportedPipelineScope,
    contract.artifact_identity?.supported_pipeline_scope,
    contract.artifactIdentity?.supportedPipelineScope,
  );
  const accepted =
    json.gpuHmrSuccess === true
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && json.visualThresholdValidation?.accepted === true
    && processContinuity.accepted === true
    && processContinuity.processRestarted === false
    && nativeApiEvidence.accepted === true
    && visual.accepted === true;
  const profileId = firstText(json.profile?.targetId, json.profile?.target_id, json.profile?.id, json.slug);
  return finalizeRow({
    artifactSchema: json.schema,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend: 'webgpu',
    targetId: profileId,
    profileId,
    proofMode: 'webgpu_wgsl_runtime_visual',
    evidenceKind: 'deterministic_visual_oracle',
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : 'unproven',
    acceptanceClass: accepted ? 'full_runtime_gpu_hmr' : 'webgpu_runtime_visual_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'webgpu_ledger_process_native_visual_chain' : 'webgpu_runtime_visual_chain_rejected',
    proofIds: proofIdsFrom(json, ledger),
    ledger,
    supportedPipelineScope,
    supported_pipeline_scope: supportedPipelineScope,
    runtimeResourceTrace,
    runtime_resource_trace: runtimeResourceTrace,
    visual,
    runMode: timingEvidence(
      ledgerRecord,
      json.timingMetrics,
      json.timing_metrics,
      json.timings,
    ),
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: boolOrNull(processContinuity.processRestarted),
    timings: {
      totalValidatorWallTimeNs: finiteNumber(json.timings?.total_validator_wall_time),
      triggerToVisibleTimeNs: finiteNumber(json.timings?.trigger_to_visible_time),
      oracleAnalysisTimeNs: finiteNumber(json.timings?.oracle_analysis_time),
    },
    reasons: accepted ? [] : compactStringList([
      ...ledger.failedInvariants.map((failure) => failure.code),
      ledger.present === true ? null : 'proof_ledger_record_missing',
      ledger.source === 'recomputed_ledger' ? null : 'proof_ledger_recomputed_query_missing',
      visual.accepted ? null : 'visual_artifacts_not_readable',
      json.visualThresholdValidation?.accepted === true ? null : 'visual_threshold_not_accepted',
      processContinuity.accepted === true ? null : 'process_continuity_not_accepted',
      nativeApiEvidence.accepted === true ? null : 'native_webgpu_api_not_accepted',
    ]),
    openGaps: accepted ? [] : ['webgpu_runtime_visual_proof_not_accepted'],
  });
}

async function webGpuRuntimeComputeRow(json, filePath, context) {
  const ledger = ledgerFacet(json);
  const proofLedger = compactObject(json.proofLedger ?? json.proof_ledger);
  const ledgerRecord = compactObject(proofLedger.records?.[0] ?? json.proofLedger?.records?.[0] ?? json.proof_ledger?.records?.[0]);
  const processContinuity = compactObject(json.browser?.processContinuity);
  const nativeApiEvidence = compactObject(json.nativeWebGpuApiEvidence);
  const contract = compactObject(json.contract ?? json.acceptanceContract ?? json.acceptance_contract);
  const webgpuContract = compactObject(contract.webgpu_contract ?? contract.webgpuContract);
  const runtimeResourceTrace = compactObject(
    webgpuContract.runtime_resource_trace
    ?? webgpuContract.runtimeResourceTrace
    ?? ledgerRecord.runtime_resource_trace
    ?? ledgerRecord.runtimeResourceTrace,
  );
  const supportedPipelineScope = firstText(
    webgpuContract.supported_pipeline_scope,
    webgpuContract.supportedPipelineScope,
    contract.artifact_identity?.supported_pipeline_scope,
    contract.artifactIdentity?.supportedPipelineScope,
  );
  const computeOracleFacet = await realRocmLedgerOutputOracleFacet(
    ledger,
    proofLedger,
    { present: false, accepted: false },
    context.repoRoot,
    path.dirname(filePath),
  );
  const directComputeArtifacts = compactObject(
    json.computeOracleArtifacts
    ?? json.compute_oracle_artifacts
    ?? ledgerRecord.oracle_artifacts?.compute_oracle_artifacts
    ?? ledgerRecord.oracleArtifacts?.computeOracleArtifacts,
  );
  const visual = await visualArtifactEvidence(
    [
      directComputeArtifacts.rendered_card_png,
      directComputeArtifacts.renderedCardPng,
      computeOracleFacet.compute?.renderedCard?.path,
    ],
    context.repoRoot,
    path.dirname(filePath),
    {},
    false,
  );
  const computeValidation = compactObject(json.computeOracleValidation ?? json.compute_oracle_validation);
  const expectedOutputVerified =
    directComputeArtifacts.expected_output_declared === true
    && directComputeArtifacts.expected_output_required !== false
    && directComputeArtifacts.expected_output_verified === true
    && computeValidation.expectedOutputVerified === true;
  const accepted =
    json.gpuHmrSuccess === true
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && computeOracleFacet.accepted === true
    && computeValidation.accepted === true
    && expectedOutputVerified
    && processContinuity.accepted === true
    && processContinuity.processRestarted === false
    && nativeApiEvidence.accepted === true
    && supportedPipelineScope === 'explicit-compute-profiled-layout-storage-uniform-float32-readback';
  const profileId = firstText(json.profile?.targetId, json.profile?.target_id, json.profile?.id, json.slug);
  return finalizeRow({
    artifactSchema: json.schema,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend: 'webgpu',
    targetId: profileId,
    profileId,
    proofMode: 'webgpu_wgsl_runtime_compute',
    evidenceKind: 'compute_oracle',
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : 'unproven',
    acceptanceClass: accepted ? 'full_runtime_gpu_hmr' : 'webgpu_runtime_compute_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'webgpu_ledger_process_native_compute_readback_chain' : 'webgpu_runtime_compute_chain_rejected',
    proofIds: proofIdsFrom(json, ledger),
    ledger,
    outputOracleFacet: computeOracleFacet,
    output_oracle_facet: computeOracleFacet,
    supportedPipelineScope,
    supported_pipeline_scope: supportedPipelineScope,
    expectedOutputVerified,
    expected_output_verified: expectedOutputVerified,
    expectedOutputHash: directComputeArtifacts.expected_output_hash,
    expected_output_hash: directComputeArtifacts.expected_output_hash,
    runtimeResourceTrace,
    runtime_resource_trace: runtimeResourceTrace,
    visual,
    runMode: timingEvidence(
      ledgerRecord,
      json.timingMetrics,
      json.timing_metrics,
      json.timings,
    ),
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: boolOrNull(processContinuity.processRestarted),
    timings: {
      totalValidatorWallTimeNs: finiteNumber(json.timings?.total_validator_wall_time),
      dispatchToOutputProofTimeNs: finiteNumber(json.timings?.dispatch_to_output_proof_time),
      oracleAnalysisTimeNs: finiteNumber(json.timings?.oracle_analysis_time),
    },
    reasons: accepted ? [] : compactStringList([
      ...ledger.failedInvariants.map((failure) => failure.code),
      ...((computeOracleFacet.failedGates ?? []).map((failure) => failure.code)),
      ledger.present === true ? null : 'proof_ledger_record_missing',
      ledger.source === 'recomputed_ledger' ? null : 'proof_ledger_recomputed_query_missing',
      computeOracleFacet.accepted === true ? null : 'compute_oracle_files_not_accepted',
      computeValidation.accepted === true ? null : 'compute_oracle_validation_not_accepted',
      expectedOutputVerified ? null : 'compute_oracle_expected_output_not_verified',
      processContinuity.accepted === true ? null : 'process_continuity_not_accepted',
      nativeApiEvidence.accepted === true ? null : 'native_webgpu_api_not_accepted',
      supportedPipelineScope === 'explicit-compute-profiled-layout-storage-uniform-float32-readback'
        ? null
        : 'webgpu_compute_supported_pipeline_scope_missing',
    ]),
    openGaps: accepted ? [] : ['webgpu_runtime_compute_readback_proof_not_accepted'],
  });
}

async function hipModuleRuntimeRow(json, filePath, context) {
  const ledger = ledgerFacet(json);
  const proofLedger = compactObject(json.proofLedger ?? json.proof_ledger);
  const ledgerRecord = compactObject(proofLedger.records?.[0] ?? json.proofLedger?.records?.[0] ?? json.proof_ledger?.records?.[0]);
  const contract = compactObject(json.contract ?? json.acceptanceContract ?? json.acceptance_contract);
  const hipContract = compactObject(contract.hip_contract ?? contract.hipContract);
  const nativeApiEvidence = compactObject(json.nativeHipApiEvidence ?? json.native_hip_api_evidence);
  const runtimeTrace = compactObject(json.runtimeTrace ?? json.runtime_trace);
  const claimBoundary = compactObject(json.claimBoundary ?? json.claim_boundary);
  const negativeEditRefusal = compactObject(json.negativeEditRefusal ?? json.negative_edit_refusal);
  const executableStaticCheck = compactObject(
    negativeEditRefusal.executableStaticCheck ?? negativeEditRefusal.executable_static_check,
  );
  const timingMetrics = compactObject(json.timingMetrics ?? json.timing_metrics);
  const timingVisualEvidence = compactObject(timingMetrics.visualEvidence ?? timingMetrics.visual_evidence);
  const computeOracleFacet = await realRocmLedgerOutputOracleFacet(
    ledger,
    proofLedger,
    { present: false, accepted: false },
    context.repoRoot,
    path.dirname(filePath),
  );
  const directComputeArtifacts = compactObject(
    json.computeOracleArtifacts
    ?? json.compute_oracle_artifacts
    ?? ledgerRecord.oracle_artifacts?.compute_oracle_artifacts
    ?? ledgerRecord.oracleArtifacts?.computeOracleArtifacts,
  );
  const computeCardEvidence = await visualArtifactEvidence(
    [
      directComputeArtifacts.rendered_card_png,
      directComputeArtifacts.renderedCardPng,
      computeOracleFacet.compute?.renderedCard?.path,
    ],
    context.repoRoot,
    path.dirname(filePath),
    {},
    false,
  );
  const computeValidation = compactObject(json.computeOracleValidation ?? json.compute_oracle_validation);
  const expectedOutputVerified =
    directComputeArtifacts.expected_output_declared === true
    && directComputeArtifacts.expected_output_required !== false
    && directComputeArtifacts.expected_output_verified === true
    && computeValidation.expectedOutputVerified === true;
  const nativeCounts = compactObject(nativeApiEvidence.counts);
  const supportedPipelineScope = firstText(
    hipContract.supported_pipeline_scope,
    hipContract.supportedPipelineScope,
    contract.artifact_identity?.supported_pipeline_scope,
    contract.artifactIdentity?.supportedPipelineScope,
    json.profile?.validationScope,
    json.profile?.validation_scope,
  );
  const artifactAfterHash = firstText(
    json.compiler?.hsacoAfterHash,
    json.compiler?.hsaco_after_hash,
    contract.artifact_hash_after,
    contract.artifactHashAfter,
    ledgerRecord.artifact_after_hash,
    ledgerRecord.artifactAfterHash,
  );
  const loaderEpoch2 = eventByEpoch(eventList(runtimeTrace.loaderEvents, runtimeTrace.loader_events), 2);
  const epochPublish2 = eventByEpoch(eventList(runtimeTrace.epochEvents, runtimeTrace.epoch_events), 2);
  const dispatchEpoch2 = eventByEpoch(eventList(runtimeTrace.dispatchEvents, runtimeTrace.dispatch_events), 2);
  const outputEpoch2 = eventByEpoch(eventList(runtimeTrace.outputEvents, runtimeTrace.output_events), 2);
  const retirementEvent = compactObject(runtimeTrace.retirementEvent ?? runtimeTrace.retirement_event);
  const runtimeTimestamps = {
    loader: eventTimestampNs(loaderEpoch2),
    epochPublish: eventTimestampNs(epochPublish2),
    dispatch: eventTimestampNs(dispatchEpoch2),
    output: eventTimestampNs(outputEpoch2),
    retirement: eventTimestampNs(retirementEvent),
  };
  const runtimeTimestampProofAccepted =
    runtimeTimestamps.loader !== null
    && runtimeTimestamps.epochPublish !== null
    && runtimeTimestamps.dispatch !== null
    && runtimeTimestamps.output !== null
    && runtimeTimestamps.retirement !== null
    && runtimeTimestamps.loader <= runtimeTimestamps.epochPublish
    && runtimeTimestamps.epochPublish <= runtimeTimestamps.dispatch
    && runtimeTimestamps.dispatch <= runtimeTimestamps.output
    && runtimeTimestamps.output <= runtimeTimestamps.retirement;
  const epoch2ArtifactHashes = [
    loaderEpoch2.artifact_hash,
    loaderEpoch2.artifactHash,
    epochPublish2.artifact_hash,
    epochPublish2.artifactHash,
    dispatchEpoch2.artifact_hash,
    dispatchEpoch2.artifactHash,
    outputEpoch2.artifact_hash,
    outputEpoch2.artifactHash,
  ].map(text).filter(Boolean);
  const epoch2ArtifactHashProofAccepted =
    Boolean(artifactAfterHash)
    && epoch2ArtifactHashes.length >= 4
    && epoch2ArtifactHashes.every((hash) => hash === artifactAfterHash);
  const claimBoundaryAccepted =
    claimBoundary.proofAuthority === 'scoped_native_hip_module_runtime_trace'
    && claimBoundary.executionBoundary === 'standalone_hip_module_probe'
    && claimBoundary.arbitraryTargetRuntimeAccepted === false
    && claimBoundary.arbitraryLibraryAccepted === false
    && claimBoundary.broadHipApplicationAcceptance === false;
  const negativeAbiRefusalAccepted =
    negativeEditRefusal.refusalProven === true
    && negativeEditRefusal.gpuHmrSuccess === false
    && negativeEditRefusal.abiCompatibilityClass === 'layout_changed'
    && executableStaticCheck.accepted === true
    && executableStaticCheck.signatureChanged === true
    && executableStaticCheck.negativeKernelFound === true
    && Boolean(firstText(executableStaticCheck.sourceAfterHash, executableStaticCheck.source_after_hash))
    && Boolean(firstText(executableStaticCheck.acceptedSignatureHash, executableStaticCheck.accepted_signature_hash))
    && Boolean(firstText(executableStaticCheck.negativeSignatureHash, executableStaticCheck.negative_signature_hash));
  const computeCardOnlyProofAccepted =
    finiteNumber(timingVisualEvidence.screenshotCount ?? timingVisualEvidence.screenshot_count) === 0
    && timingVisualEvidence.accepted === false
    && firstText(timingVisualEvidence.reason) === 'hip_module_readback_uses_compute_card_not_runtime_frame_visual_proof';
  const accepted =
    json.gpuHmrSuccess === true
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && computeOracleFacet.accepted === true
    && computeValidation.accepted === true
    && expectedOutputVerified
    && runtimeTrace.processRestarted === false
    && runtimeTrace.sameProcess === true
    && nativeApiEvidence.accepted === true
    && Number(nativeCounts.hipModuleLoadData ?? 0) >= 2
    && Number(nativeCounts.hipModuleGetFunction ?? 0) >= 2
    && Number(nativeCounts.hipModuleLaunchKernel ?? 0) >= 2
    && supportedPipelineScope === 'explicit-hip-module-float32-readback'
    && claimBoundaryAccepted
    && negativeAbiRefusalAccepted
    && runtimeTimestampProofAccepted
    && epoch2ArtifactHashProofAccepted
    && computeCardOnlyProofAccepted;
  const profileId = firstText(json.profile?.targetId, json.profile?.target_id, json.profile?.id, json.slug);
  return finalizeRow({
    artifactSchema: json.schema,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend: 'hip',
    targetId: profileId,
    profileId,
    proofMode: 'hip_module_runtime_readback',
    evidenceKind: 'compute_oracle',
    matrixOutcome: accepted ? 'full_runtime_gpu_hmr' : 'unproven',
    acceptanceClass: accepted ? 'scoped_hip_module_runtime_hmr' : 'hip_module_runtime_rejected',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted,
    proofChain: accepted ? 'hip_module_ledger_native_api_readback_chain' : 'hip_module_runtime_chain_rejected',
    proofIds: proofIdsFrom(json, ledger),
    ledger,
    outputOracleFacet: computeOracleFacet,
    output_oracle_facet: computeOracleFacet,
    supportedPipelineScope,
    supported_pipeline_scope: supportedPipelineScope,
    expectedOutputVerified,
    expected_output_verified: expectedOutputVerified,
    expectedOutputHash: directComputeArtifacts.expected_output_hash,
    expected_output_hash: directComputeArtifacts.expected_output_hash,
    nativeHipApiEvidence: nativeApiEvidence,
    native_hip_api_evidence: nativeApiEvidence,
    runtimeTrace,
    runtime_trace: runtimeTrace,
    claimBoundary,
    claim_boundary: claimBoundary,
    claimBoundaryAccepted,
    claim_boundary_accepted: claimBoundaryAccepted,
    negativeEditRefusal,
    negative_edit_refusal: negativeEditRefusal,
    negativeAbiRefusalAccepted,
    negative_abi_refusal_accepted: negativeAbiRefusalAccepted,
    runtimeTimestampProof: {
      accepted: runtimeTimestampProofAccepted,
      timestamps: runtimeTimestamps,
    },
    runtime_timestamp_proof: {
      accepted: runtimeTimestampProofAccepted,
      timestamps: runtimeTimestamps,
    },
    epoch2ArtifactHashProof: {
      accepted: epoch2ArtifactHashProofAccepted,
      artifactAfterHash,
      observedArtifactHashes: epoch2ArtifactHashes,
    },
    epoch2_artifact_hash_proof: {
      accepted: epoch2ArtifactHashProofAccepted,
      artifact_after_hash: artifactAfterHash,
      observed_artifact_hashes: epoch2ArtifactHashes,
    },
    computeCardOnlyProofAccepted,
    compute_card_only_proof_accepted: computeCardOnlyProofAccepted,
    visual: {
      required: false,
      accepted: false,
      evidenceKind: 'compute_card_not_runtime_visual_oracle',
      reason: 'hip_module_readback_card_is_human_compute_evidence_not_frame_visual_proof',
    },
    computeCardEvidence,
    compute_card_evidence: computeCardEvidence,
    runMode: timingEvidence(
      ledgerRecord,
      json.timingMetrics,
      json.timing_metrics,
      json.timings,
    ),
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: boolOrNull(runtimeTrace.processRestarted),
    timings: {
      totalValidatorWallTimeNs: finiteNumber(json.timings?.total_validator_wall_time),
      dispatchToOutputProofTimeNs: finiteNumber(json.timings?.dispatch_to_output_proof_time),
      oracleAnalysisTimeNs: finiteNumber(json.timings?.oracle_analysis_time),
    },
    reasons: accepted ? [] : compactStringList([
      ...ledger.failedInvariants.map((failure) => failure.code),
      ...((computeOracleFacet.failedGates ?? []).map((failure) => failure.code)),
      ledger.present === true ? null : 'proof_ledger_record_missing',
      ledger.source === 'recomputed_ledger' ? null : 'proof_ledger_recomputed_query_missing',
      computeOracleFacet.accepted === true ? null : 'compute_oracle_files_not_accepted',
      computeValidation.accepted === true ? null : 'compute_oracle_validation_not_accepted',
      expectedOutputVerified ? null : 'compute_oracle_expected_output_not_verified',
      runtimeTrace.sameProcess === true ? null : 'same_process_not_accepted',
      runtimeTrace.processRestarted === false ? null : 'process_continuity_not_accepted',
      nativeApiEvidence.accepted === true ? null : 'native_hip_api_not_accepted',
      supportedPipelineScope === 'explicit-hip-module-float32-readback'
        ? null
        : 'hip_module_supported_pipeline_scope_missing',
      claimBoundaryAccepted ? null : 'hip_module_claim_boundary_not_scoped',
      negativeAbiRefusalAccepted ? null : 'hip_module_negative_abi_refusal_not_executable',
      runtimeTimestampProofAccepted ? null : 'hip_module_runtime_event_timestamps_not_observed',
      epoch2ArtifactHashProofAccepted ? null : 'hip_module_epoch2_artifact_hash_chain_not_proven',
      computeCardOnlyProofAccepted ? null : 'hip_module_compute_card_not_separated_from_visual_proof',
    ]),
    openGaps: accepted ? [] : ['hip_module_runtime_readback_proof_not_accepted'],
  });
}

async function externalProjectRow(json, filePath, context) {
  const profileId = firstText(json.profile?.id, json.profileId, path.basename(filePath).replace(/-\d+-report\.json$/, ''));
  const backend = profileId?.includes('bevy') ? 'bevy_wgsl' : 'webgl';
  const visualArtifacts = compactObject(json.visualOracleArtifacts ?? json.visual_oracle_artifacts);
  const visualDiff = compactObject(json.visualDiff ?? json.visual_diff);
  const visual = await visualArtifactEvidence(
    [visualArtifacts.before_image, visualArtifacts.after_image, visualArtifacts.diff_image],
    context.repoRoot,
    path.dirname(filePath),
    visualDiff,
    json.status === 'pass',
  );
  const deterministicAccepted = json.deterministicVisualModeEvaluation?.accepted === true
    || json.deterministic_visual_mode_evaluation?.accepted === true;
  const visualProfileAccepted =
    json.status === 'pass'
    && visual.accepted === true
    && deterministicAccepted;
  const rejection = compactObject(json.rejectionProofArtifact ?? json.rejection_proof_artifact);
  const refusalProven =
    json.status === 'fail'
    && Boolean(firstText(rejection.proofId, rejection.proof_id))
    && Array.isArray(rejection.reasons)
    && rejection.reasons.length > 0;
  const linkedRejection = await readExternalRejectionProof(
    firstText(rejection.path, rejection.localPath, rejection.local_path),
    context.repoRoot,
    path.dirname(filePath),
    profileId,
  );
  const rejectionReasons = compactStringList([
    ...(Array.isArray(rejection.reasons) ? rejection.reasons : []),
    ...linkedRejection.reasons,
  ]);
  const runMode = timingEvidence(json.timingMetrics, json.timing_metrics, json.timings);
  return finalizeRow({
    artifactSchema: json.schemaVersion,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId: profileId,
    profileId,
    proofMode: firstText(json.proofMode, json.profile?.proofMode),
    evidenceKind: visualProfileAccepted ? 'external_visual_oracle' : 'external_profile_result',
    matrixOutcome: visualProfileAccepted
      ? 'visual_profile_accepted'
      : refusalProven
        ? 'refusal_proven'
        : 'unproven',
    acceptanceClass: visualProfileAccepted
      ? 'visual_profile_not_full_gpu_hmr_ledger'
      : refusalProven
        ? 'external_profile_refusal'
        : 'external_profile_unproven',
    acceptedForGpuHmr: false,
    visualProfileAccepted,
    gpuHmrSuccess: false,
    refusalProven,
    proofChainAccepted: visualProfileAccepted || refusalProven,
    proofChain: visualProfileAccepted
      ? 'external_screenshot_visual_oracle'
      : refusalProven
        ? 'external_rejection_artifact'
        : 'external_profile_unproven',
    proofIds: proofIdsFrom(json, rejection, linkedRejection.proof),
    ledger: {
      present: false,
      proofId: null,
      gpuHmrSuccess: false,
      failedInvariants: [],
    },
    visual,
    runMode,
    cpuHmrUsed: null,
    fullRebuildUsed: null,
    processRestarted: null,
    timings: {
      totalMs: finiteNumber(json.timings?.totalMs ?? json.duration_ms),
      editToFirstVisualMs: finiteNumber(json.timings?.editToScreenshotMs),
      visualDiffMs: finiteNumber(json.timings?.visualDiffMs),
    },
    reasons: compactStringList([
      ...rejectionReasons,
      json.error?.message ? 'external_profile_failed' : null,
      visualProfileAccepted || visual.accepted ? null : 'visual_artifacts_not_readable',
    ]),
    openGaps: visualProfileAccepted
      ? ['full_runtime_gpu_hmr_ledger_not_present']
      : refusalProven
        ? ['full_runtime_gpu_hmr_not_proven']
        : ['external_profile_not_accepted'],
  });
}

async function readExternalRejectionProof(proofPath, repoRoot, baseDir, expectedProfileId = null) {
  const resolved = resolveEvidencePath(proofPath, repoRoot, baseDir);
  if (!resolved) return { proof: null, reasons: [] };
  const json = await readJson(resolved);
  if (!isObject(json)) return { proof: null, reasons: [] };
  const schema = firstText(json.schemaVersion, json.schema);
  const profileId = firstText(json.profileId, json.profile_id);
  const rejection = compactObject(json.rejection);
  const accepted = schema === 'synthi.gpu.hmr.external_project_rejection.v1'
    && (!expectedProfileId || profileId === expectedProfileId)
    && json.status === 'fail'
    && rejection.accepted === false
    && Array.isArray(rejection.reasons)
    && rejection.reasons.length > 0;
  return accepted
    ? { proof: json, reasons: compactStringList(rejection.reasons) }
    : { proof: null, reasons: [] };
}

async function externalProjectRejectionRow(json, filePath, context) {
  const profileId = firstText(json.profileId, json.profile_id, path.basename(filePath).replace(/-\d+-rejection-proof\.json$/, ''));
  if (isSelfCheckId(profileId) || isSelfCheckId(filePath)) return null;
  const backend = profileId?.includes('bevy') ? 'bevy_wgsl' : 'webgl';
  const rejection = compactObject(json.rejection);
  const reasons = compactStringList(rejection.reasons);
  const refusalProven =
    firstText(json.schemaVersion, json.schema) === 'synthi.gpu.hmr.external_project_rejection.v1'
    && json.status === 'fail'
    && rejection.accepted === false
    && reasons.length > 0;
  return finalizeRow({
    artifactSchema: firstText(json.schemaVersion, json.schema),
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId: profileId,
    profileId,
    proofMode: firstText(json.proofMode, json.proof_mode, 'external_rejection'),
    evidenceKind: 'external_profile_result',
    matrixOutcome: refusalProven ? 'refusal_proven' : 'unproven',
    acceptanceClass: refusalProven ? 'external_profile_refusal' : 'external_profile_rejection_unproven',
    acceptedForGpuHmr: false,
    visualProfileAccepted: false,
    gpuHmrSuccess: false,
    refusalProven,
    proofChainAccepted: refusalProven,
    proofChain: refusalProven ? 'external_rejection_artifact' : 'external_rejection_artifact_unproven',
    proofIds: proofIdsFrom(json),
    ledger: {
      present: false,
      source: 'missing',
      proofId: null,
      gpuHmrSuccess: false,
      failedInvariants: [],
    },
    visual: {
      required: false,
      present: false,
      accepted: true,
      imageCount: 0,
      existingImageCount: 0,
      pngImageCount: 0,
      allImagesExist: true,
      allImagesArePng: true,
      changedPixelRatio: null,
      meanAbsDelta8bit: null,
      visiblePixelCount: null,
      images: [],
    },
    runMode: timingEvidence(json.timingMetrics, json.timing_metrics, json.timings),
    cpuHmrUsed: null,
    fullRebuildUsed: null,
    processRestarted: null,
    timings: {},
    reasons,
    openGaps: refusalProven ? ['full_runtime_gpu_hmr_not_proven'] : ['external_rejection_artifact_not_accepted'],
  });
}

function preflightBackend(schema) {
  if (schema.includes('oidn_preflight')) return 'oidn_hip';
  if (schema.includes('opencl_preflight')) return 'opencl';
  if (schema.includes('vulkan_preflight')) return 'vulkan';
  if (schema.includes('webgpu_preflight')) return 'webgpu';
  return 'unknown';
}

function preflightAcceptedField(backend, acceptance) {
  if (backend === 'oidn_hip') return acceptance.acceptedForHipOutputProof === true;
  if (backend === 'opencl') return acceptance.acceptedForOpenClOutputProof === true;
  if (backend === 'vulkan') return acceptance.acceptedForVulkanPipelineProof === true;
  if (backend === 'webgpu') return acceptance.acceptedForWebGpuPipelineProof === true;
  return false;
}

function preflightRuntimeOnlyAccepted(backend, acceptance) {
  if (backend === 'webgpu') return acceptance.acceptedForWebGpuRuntimePreflight === true;
  if (backend === 'opencl') return acceptance.acceptedForOpenClRuntimePreflight === true;
  if (backend === 'vulkan') return acceptance.acceptedForVulkanRuntimePreflight === true;
  return false;
}

async function preflightRow(json, filePath, context) {
  const schema = firstText(json.schema, json.schemaVersion) ?? 'unknown';
  const backend = preflightBackend(schema);
  const acceptance = compactObject(json.acceptance);
  const classification = compactObject(json.classification);
  const proofAccepted = preflightAcceptedField(backend, acceptance);
  const runtimeOnlyAccepted = preflightRuntimeOnlyAccepted(backend, acceptance);
  const unsupportedReasons = compactStringList(classification.unsupportedReasons ?? classification.unsupported_reasons);
  const noShimApplied = acceptance.noShimApplied === true;
  const noSymlinkApplied = acceptance.noSymlinkApplied === true;
  const noSynthesizedRuntime =
    acceptance.noVendorIcdSynthesized === true
    || acceptance.noIcdSynthesized === true
    || acceptance.noSynthesizedRuntime === true;
  const refusalProven =
    proofAccepted === false
    && unsupportedReasons.length > 0
    && noShimApplied
    && noSymlinkApplied
    && noSynthesizedRuntime;
  const visual = await visualArtifactEvidence(
    [classification.diagnosticScreenshot],
    context.repoRoot,
    path.dirname(filePath),
    {},
    false,
  );
  const matrixOutcome = proofAccepted
    ? 'unproven'
    : runtimeOnlyAccepted
      ? 'preflight_only'
      : refusalProven
        ? 'refusal_proven'
        : 'unproven';
  const runMode = timingEvidence(json.timingMetrics, json.timing_metrics, json.timings);
  return finalizeRow({
    artifactSchema: schema,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId: firstText(json.slug, backend),
    profileId: firstText(json.slug, backend),
    proofMode: 'runtime_preflight',
    evidenceKind: backend === 'webgpu' ? 'runtime_preflight_diagnostic' : 'runtime_preflight_refusal',
    matrixOutcome,
    acceptanceClass: matrixOutcome,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven,
    proofChainAccepted: matrixOutcome === 'preflight_only' || refusalProven,
    proofChain: matrixOutcome === 'preflight_only'
      ? 'runtime_preflight_only'
      : refusalProven
        ? 'structured_runtime_refusal'
        : 'preflight_unproven',
    proofIds: proofIdsFrom(json),
    ledger: {
      present: false,
      proofId: null,
      gpuHmrSuccess: false,
      failedInvariants: [],
    },
    visual,
    runMode,
    cpuHmrUsed: null,
    fullRebuildUsed: null,
    processRestarted: null,
    noShimEvidence: {
      noShimApplied: boolOrNull(acceptance.noShimApplied),
      noSymlinkApplied: boolOrNull(acceptance.noSymlinkApplied),
      noVendorIcdSynthesized: boolOrNull(acceptance.noVendorIcdSynthesized),
      noIcdSynthesized: boolOrNull(acceptance.noIcdSynthesized),
      noSynthesizedRuntime: boolOrNull(acceptance.noSynthesizedRuntime),
      noBrowserFlagClaimedAsHmr: boolOrNull(acceptance.noBrowserFlagClaimedAsHmr),
    },
    reasons: compactStringList([
      ...unsupportedReasons,
      acceptance.reason,
      proofAccepted ? 'preflight_does_not_prove_required_output_or_pipeline' : null,
    ]),
    openGaps: matrixOutcome === 'preflight_only'
      ? ['shader_pipeline_or_output_oracle_not_proven']
      : refusalProven
        ? compactStringList([
          backend === 'opencl' ? 'real_opencl_vendor_icd_required' : null,
          backend === 'vulkan' ? 'real_vulkan_icd_required' : null,
          backend === 'oidn_hip' ? 'matching_oidn_hip_runtime_required' : null,
        ])
        : ['runtime_preflight_not_accepted'],
  });
}

function realRocmCheck(records, name, fromEnd = true) {
  if (!Array.isArray(records)) return null;
  return detailRecord(records, name, fromEnd);
}

function realRocmCheckDetailJson(records, name, fromEnd = true) {
  const detail = text(realRocmCheck(records, name, fromEnd)?.detail);
  if (!detail) return null;
  const jsonStart = detail.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    return JSON.parse(detail.slice(jsonStart));
  } catch {
    return null;
  }
}

function realRocmRequiredFullRuntimeProof(json) {
  const targetProgression = compactObject(json.target_progression ?? json.targetProgression);
  const profileProofObligations = compactObject(
    json.real_rocm_profile_proof_obligations
    ?? json.realRocmProfileProofObligations
    ?? json.profile_proof_obligations
    ?? json.profileProofObligations
    ?? json.summary?.real_rocm_profile_proof_obligations
    ?? json.summary?.realRocmProfileProofObligations,
  );
  return json.fullRuntimeProofRequired === true
    || json.full_runtime_proof_required === true
    || targetProgression.required === true
    || profileProofObligations.requiresFullRuntimeProof === true
    || profileProofObligations.requires_full_runtime_proof === true
    || json.command?.env?.SYNTHI_REAL_ROCM_REQUIRE_FULL_RUNTIME_PROOF === '1'
    || json.command?.env?.SYNTHI_GPU_HMR_REQUIRE_FULL_RUNTIME_PROOF === '1';
}

function ledgerRecordsFromValue(ledger) {
  const records = Array.isArray(ledger.records) ? ledger.records : [ledger];
  return records.map(compactObject).filter((record) => Object.keys(record).length > 0);
}

function nestedArtifactObject(...values) {
  for (const value of values) {
    const object = compactObject(value);
    if (Object.keys(object).length > 0) return object;
  }
  return {};
}

function ledgerRecordHasVisualOutput(record) {
  const outputEvent = compactObject(record.output_event ?? record.outputEvent);
  const oracleArtifacts = compactObject(record.oracle_artifacts ?? record.oracleArtifacts);
  const outputOracle = compactObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
  const outputOracleArtifacts = compactObject(outputOracle.oracle_artifacts ?? outputOracle.oracleArtifacts);
  const kind = String(firstText(outputEvent.kind, outputEvent.oracle_kind, outputEvent.oracleKind) ?? '').toLowerCase();
  const visualArtifacts = nestedArtifactObject(
    oracleArtifacts.visual_oracle_artifacts,
    oracleArtifacts.visualOracleArtifacts,
    outputEvent.visual_oracle_artifacts,
    outputEvent.visualOracleArtifacts,
    outputOracle.visual_oracle_artifacts,
    outputOracle.visualOracleArtifacts,
    outputOracleArtifacts.visual_oracle_artifacts,
    outputOracleArtifacts.visualOracleArtifacts,
  );
  return kind.includes('visual')
    || kind.includes('render')
    || kind.includes('frame')
    || kind.includes('pixel')
    || Object.keys(visualArtifacts).length > 0;
}

function ledgerRecordComputeOracleArtifacts(record) {
  const outputEvent = compactObject(record.output_event ?? record.outputEvent);
  const oracleArtifacts = compactObject(record.oracle_artifacts ?? record.oracleArtifacts);
  const outputOracle = compactObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
  const outputOracleArtifacts = compactObject(outputOracle.oracle_artifacts ?? outputOracle.oracleArtifacts);
  return nestedArtifactObject(
    oracleArtifacts.compute_oracle_artifacts,
    oracleArtifacts.computeOracleArtifacts,
    outputEvent.compute_oracle_artifacts,
    outputEvent.computeOracleArtifacts,
    outputOracle.compute_oracle_artifacts,
    outputOracle.computeOracleArtifacts,
    outputOracleArtifacts.compute_oracle_artifacts,
    outputOracleArtifacts.computeOracleArtifacts,
  );
}

function resolveComputeOracleArtifactPaths(artifacts, repoRoot, baseDir) {
  const out = { ...artifacts };
  for (const [snakeName, camelName] of [
    ['raw_readback_bin', 'rawReadbackBin'],
    ['readback_schema_json', 'readbackSchemaJson'],
    ['rendered_card_png', 'renderedCardPng'],
  ]) {
    const value = firstText(out[snakeName], out[camelName]);
    if (!value) continue;
    const resolved = resolveEvidencePath(value, repoRoot, baseDir);
    if (!resolved) continue;
    out[snakeName] = resolved;
    out[camelName] = resolved;
  }
  return out;
}

async function realRocmComputeOracleFileIntegrityFacet(proofLedger, repoRoot, baseDir) {
  const computeArtifacts = ledgerRecordsFromValue(proofLedger)
    .map(ledgerRecordComputeOracleArtifacts)
    .find((artifacts) => Object.keys(artifacts).length > 0);
  if (!computeArtifacts) {
    return {
      present: false,
      accepted: false,
      source: 'missing',
      failedGates: [{ code: 'compute_oracle_artifacts_missing' }],
    };
  }
  const resolvedArtifacts = resolveComputeOracleArtifactPaths(computeArtifacts, repoRoot, baseDir);
  const enriched = await computeOracleArtifactsFromFiles(resolvedArtifacts);
  const verification = compactObject(
    enriched?.raw_readback_verification
    ?? enriched?.rawReadbackVerification,
  );
  const rawReadbackPath = firstText(resolvedArtifacts.raw_readback_bin, resolvedArtifacts.rawReadbackBin);
  const schemaPath = firstText(resolvedArtifacts.readback_schema_json, resolvedArtifacts.readbackSchemaJson);
  const renderedCardPath = firstText(resolvedArtifacts.rendered_card_png, resolvedArtifacts.renderedCardPng);
  let renderedCard = {
    present: Boolean(renderedCardPath),
    decoded: false,
    decodeError: null,
    format: null,
    width: null,
    height: null,
  };
  if (renderedCardPath) {
    try {
      const metadata = await sharp(renderedCardPath).metadata();
      renderedCard = {
        present: true,
        decoded: true,
        decodeError: null,
        format: metadata.format ?? null,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
      };
    } catch (error) {
      renderedCard = {
        present: true,
        decoded: false,
        decodeError: error?.message ? String(error.message) : String(error),
        format: null,
        width: null,
        height: null,
      };
    }
  }
  const rawReadbackByteLength = finiteNumber(
    verification.byte_length
    ?? verification.byteLength,
  );
  const schemaByteLength = finiteNumber(
    verification.readback_schema_byte_length
    ?? verification.readbackSchemaByteLength,
  );
  const hashVerified =
    verification.hash_verified === true
    || verification.hashVerified === true;
  const deterministicSliceHashVerified =
    verification.deterministic_slice_hash_verified === true
    || verification.deterministicSliceHashVerified === true;
  const failedGates = compactStringList([
    rawReadbackPath ? null : 'compute_oracle_raw_readback_path_missing',
    hashVerified ? null : 'compute_oracle_raw_readback_hash_unverified',
    rawReadbackByteLength && rawReadbackByteLength > 0 ? null : 'compute_oracle_raw_readback_bytes_missing',
    deterministicSliceHashVerified ? null : 'compute_oracle_deterministic_slice_hash_unverified',
    verification.raw_readback_read_error ? 'compute_oracle_raw_readback_unreadable' : null,
    schemaPath ? null : 'compute_oracle_readback_schema_path_missing',
    schemaByteLength && schemaByteLength > 0 ? null : 'compute_oracle_readback_schema_bytes_missing',
    verification.readback_schema_read_error ? 'compute_oracle_readback_schema_unreadable' : null,
    renderedCard.present ? null : 'compute_oracle_rendered_card_path_missing',
    renderedCard.decoded ? null : 'compute_oracle_rendered_card_decode_failed',
    renderedCard.decoded && renderedCard.format === 'png' ? null : 'compute_oracle_rendered_card_not_png',
  ]).map((code) => ({ code }));
  return {
    present: true,
    accepted: failedGates.length === 0,
    source: 'matrix_verified_compute_oracle_files',
    failedGates,
    rawReadbackHash: firstText(enriched?.raw_readback_hash, enriched?.rawReadbackHash),
    rawReadbackByteLength,
    rawReadbackHashVerified: hashVerified,
    deterministicSliceHashVerified,
    readbackSchemaByteLength: schemaByteLength,
    readbackSchemaReadError: firstText(verification.readback_schema_read_error, verification.readbackSchemaReadError),
    renderedCard,
    rawReadbackReadError: firstText(verification.raw_readback_read_error, verification.rawReadbackReadError),
  };
}

async function realRocmLedgerOutputOracleFacet(ledger, proofLedger, visual, repoRoot, baseDir) {
  const ledgerAccepted = ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0;
  if (!ledgerAccepted) {
    return {
      accepted: false,
      kind: 'ledger_rejected',
      compute: null,
      failedGates: [{ code: 'proof_ledger_success_required' }],
    };
  }
  const visualLedgerOutput = ledgerRecordsFromValue(proofLedger).some(ledgerRecordHasVisualOutput);
  if (visualLedgerOutput) {
    return {
      accepted: visual.present === true && visual.accepted === true,
      kind: 'visual_oracle',
      compute: null,
      failedGates: visual.present === true && visual.accepted === true
        ? []
        : [{ code: 'visual_oracle_artifacts_not_accepted' }],
    };
  }
  const compute = await realRocmComputeOracleFileIntegrityFacet(proofLedger, repoRoot, baseDir);
  return {
    accepted: compute.accepted === true,
    kind: 'compute_oracle',
    compute,
    failedGates: compute.failedGates,
  };
}

async function realRocmRepoValidationRow(json, filePath, context) {
  const profile = compactObject(json.real_rocm_profile ?? json.realRocmProfile);
  const summary = compactObject(json.validation_proof_summary ?? json.validationProofSummary);
  const checks = Array.isArray(json.checks) ? json.checks : [];
  const runtimeProofArtifact = runtimeProofArtifactFromValue(json);
  const runtimeProofArtifactGate = runtimeProofArtifactFacet(runtimeProofArtifact);
  const ledger = runModeLedgerFacet(json, runtimeProofArtifact);
  const proofLedger = compactObject(
    json.proofLedger
    ?? json.proof_ledger
    ?? runtimeProofArtifact.proofLedger
    ?? runtimeProofArtifact.proof_ledger,
  );
  const realRocmFirewall = realRocmFirewallFieldsFromEvidence({
    json,
    summary,
    runtimeProofArtifact,
    proofLedger,
  });
  const strictGates = compactObject(
    json.strict_proof_gates
    ?? json.strictProofGates
    ?? summary.strict_proof_gates
    ?? summary.strictProofGates,
  );
  const strictGateFailures = compactStringList(strictGates.failures);
  const outputOracleResolution = compactObject(
    json.output_oracle_resolution
    ?? json.outputOracleResolution
    ?? summary.output_oracle_resolution
    ?? summary.outputOracleResolution,
  );
  const targetProgression = compactObject(
    json.target_progression
    ?? json.targetProgression
    ?? summary.target_progression
    ?? summary.targetProgression,
  );
  const targetProgressionGates = compactObjectList(
    json.target_progression_gates
    ?? json.targetProgressionGates
    ?? summary.target_progression_gates
    ?? summary.targetProgressionGates,
  );
  const targetProgressionGateFailures = targetProgressionGates
    .filter((gate) => text(gate.status)?.toLowerCase() === 'fail');
  const nativeRocmLaunchBoundary = compactObject(
    json.native_rocm_launch_boundary
    ?? json.nativeRocmLaunchBoundary
    ?? summary.native_rocm_launch_boundary
    ?? summary.nativeRocmLaunchBoundary
    ?? runtimeProofArtifact.native_rocm_launch_boundary
    ?? runtimeProofArtifact.nativeRocmLaunchBoundary,
  );
  const realRocmRuntimeEligibility = compactObject(
    json.real_rocm_runtime_eligibility
    ?? json.realRocmRuntimeEligibility
    ?? json.native_runtime_eligibility
    ?? json.nativeRuntimeEligibility
    ?? summary.real_rocm_runtime_eligibility
    ?? summary.realRocmRuntimeEligibility
    ?? summary.native_runtime_eligibility
    ?? summary.nativeRuntimeEligibility
    ?? runtimeProofArtifact.real_rocm_runtime_eligibility
    ?? runtimeProofArtifact.realRocmRuntimeEligibility
    ?? runtimeProofArtifact.native_runtime_eligibility
    ?? runtimeProofArtifact.nativeRuntimeEligibility,
  );
  const realRocmProfileProofObligations = compactObject(
    json.real_rocm_profile_proof_obligations
    ?? json.realRocmProfileProofObligations
    ?? json.profile_proof_obligations
    ?? json.profileProofObligations
    ?? summary.real_rocm_profile_proof_obligations
    ?? summary.realRocmProfileProofObligations
    ?? summary.profile_proof_obligations
    ?? summary.profileProofObligations
    ?? runtimeProofArtifact.real_rocm_profile_proof_obligations
    ?? runtimeProofArtifact.realRocmProfileProofObligations
    ?? runtimeProofArtifact.profile_proof_obligations
    ?? runtimeProofArtifact.profileProofObligations,
  );
  const realRocmAppHookContract = compactObject(
    json.real_rocm_app_hook_contract
    ?? json.realRocmAppHookContract
    ?? json.app_hook_contract
    ?? json.appHookContract
    ?? summary.real_rocm_app_hook_contract
    ?? summary.realRocmAppHookContract
    ?? summary.app_hook_contract
    ?? summary.appHookContract
    ?? runtimeProofArtifact.real_rocm_app_hook_contract
    ?? runtimeProofArtifact.realRocmAppHookContract
    ?? runtimeProofArtifact.app_hook_contract
    ?? runtimeProofArtifact.appHookContract,
  );
  const realRocmDeviceSidecarContract = compactObject(
    json.real_rocm_device_sidecar_contract
    ?? json.realRocmDeviceSidecarContract
    ?? json.device_sidecar_contract
    ?? json.deviceSidecarContract
    ?? summary.real_rocm_device_sidecar_contract
    ?? summary.realRocmDeviceSidecarContract
    ?? summary.device_sidecar_contract
    ?? summary.deviceSidecarContract
    ?? runtimeProofArtifact.real_rocm_device_sidecar_contract
    ?? runtimeProofArtifact.realRocmDeviceSidecarContract
    ?? runtimeProofArtifact.device_sidecar_contract
    ?? runtimeProofArtifact.deviceSidecarContract,
  );
  const realRocmSidecarRuntimeConsistency = compactObject(
    json.real_rocm_sidecar_runtime_consistency
    ?? json.realRocmSidecarRuntimeConsistency
    ?? json.sidecar_runtime_consistency
    ?? json.sidecarRuntimeConsistency
    ?? summary.real_rocm_sidecar_runtime_consistency
    ?? summary.realRocmSidecarRuntimeConsistency
    ?? summary.sidecar_runtime_consistency
    ?? summary.sidecarRuntimeConsistency
    ?? runtimeProofArtifact.real_rocm_sidecar_runtime_consistency
    ?? runtimeProofArtifact.realRocmSidecarRuntimeConsistency
    ?? runtimeProofArtifact.sidecar_runtime_consistency
    ?? runtimeProofArtifact.sidecarRuntimeConsistency,
  );
  const realRocmCompileBridge = compactObject(
    json.real_rocm_compile_bridge
    ?? json.realRocmCompileBridge
    ?? summary.real_rocm_compile_bridge
    ?? summary.realRocmCompileBridge
    ?? runtimeProofArtifact.real_rocm_compile_bridge
    ?? runtimeProofArtifact.realRocmCompileBridge,
  );
  const realRocmRuntimeCapabilityPreflight = realRocmRuntimeCapabilityPreflightFacet(
    runtimeCapabilityPreflightFromSources({
      json,
      summary,
      runtimeProofArtifact,
    }),
  );
  const nativeRocmBoundaryGaps = compactStringList([
    ...(Array.isArray(nativeRocmLaunchBoundary.blockingGaps) ? nativeRocmLaunchBoundary.blockingGaps : []),
    ...(Array.isArray(nativeRocmLaunchBoundary.blocking_gaps) ? nativeRocmLaunchBoundary.blocking_gaps : []),
  ]);
  const realRocmRuntimeEligibilityGaps = compactStringList([
    ...(Array.isArray(realRocmRuntimeEligibility.blockingGaps) ? realRocmRuntimeEligibility.blockingGaps : []),
    ...(Array.isArray(realRocmRuntimeEligibility.blocking_gaps) ? realRocmRuntimeEligibility.blocking_gaps : []),
  ]);
  const realRocmProfileProofObligationsGaps = compactStringList([
    ...(Array.isArray(realRocmProfileProofObligations.blockingGaps) ? realRocmProfileProofObligations.blockingGaps : []),
    ...(Array.isArray(realRocmProfileProofObligations.blocking_gaps) ? realRocmProfileProofObligations.blocking_gaps : []),
  ]);
  const realRocmAppHookContractGaps = compactStringList([
    ...(Array.isArray(realRocmAppHookContract.blockingGaps) ? realRocmAppHookContract.blockingGaps : []),
    ...(Array.isArray(realRocmAppHookContract.blocking_gaps) ? realRocmAppHookContract.blocking_gaps : []),
  ]);
  const realRocmDeviceSidecarContractGaps = compactStringList([
    ...(Array.isArray(realRocmDeviceSidecarContract.blockingGaps) ? realRocmDeviceSidecarContract.blockingGaps : []),
    ...(Array.isArray(realRocmDeviceSidecarContract.blocking_gaps) ? realRocmDeviceSidecarContract.blocking_gaps : []),
  ]);
  const realRocmSidecarRuntimeConsistencyGaps = compactStringList([
    ...(Array.isArray(realRocmSidecarRuntimeConsistency.blockingGaps) ? realRocmSidecarRuntimeConsistency.blockingGaps : []),
    ...(Array.isArray(realRocmSidecarRuntimeConsistency.blocking_gaps) ? realRocmSidecarRuntimeConsistency.blocking_gaps : []),
  ]);
  const realRocmCompileBridgeGaps = compactStringList([
    ...(Array.isArray(realRocmCompileBridge.blockingGaps) ? realRocmCompileBridge.blockingGaps : []),
    ...(Array.isArray(realRocmCompileBridge.blocking_gaps) ? realRocmCompileBridge.blocking_gaps : []),
  ]);
  const realRocmRuntimeCapabilityPreflightGaps = compactStringList([
    ...(Array.isArray(realRocmRuntimeCapabilityPreflight.blockingGaps)
      ? realRocmRuntimeCapabilityPreflight.blockingGaps
      : []),
    ...(Array.isArray(realRocmRuntimeCapabilityPreflight.blocking_gaps)
      ? realRocmRuntimeCapabilityPreflight.blocking_gaps
      : []),
  ]);
  const nativeRocmBoundaryReason =
    Object.keys(nativeRocmLaunchBoundary).length > 0
      ? firstText(nativeRocmLaunchBoundary.status, nativeRocmLaunchBoundary.reason)
      : null;
  const realRocmRuntimeEligibilityReason =
    Object.keys(realRocmRuntimeEligibility).length > 0
      ? firstText(realRocmRuntimeEligibility.status, realRocmRuntimeEligibility.reason)
      : null;
  const realRocmProfileProofObligationsReason =
    Object.keys(realRocmProfileProofObligations).length > 0
      ? firstText(realRocmProfileProofObligations.status, realRocmProfileProofObligations.reason)
      : null;
  const realRocmAppHookContractReason =
    Object.keys(realRocmAppHookContract).length > 0
      ? firstText(realRocmAppHookContract.status, realRocmAppHookContract.reason)
      : null;
  const realRocmDeviceSidecarContractReason =
    Object.keys(realRocmDeviceSidecarContract).length > 0
      ? firstText(realRocmDeviceSidecarContract.status, realRocmDeviceSidecarContract.reason)
      : null;
  const realRocmSidecarRuntimeConsistencyReason =
    Object.keys(realRocmSidecarRuntimeConsistency).length > 0
      ? firstText(realRocmSidecarRuntimeConsistency.status, realRocmSidecarRuntimeConsistency.reason)
      : null;
  const realRocmCompileBridgeReason =
    Object.keys(realRocmCompileBridge).length > 0
      ? firstText(realRocmCompileBridge.status, realRocmCompileBridge.reason)
      : null;
  const realRocmRuntimeCapabilityPreflightReason =
    realRocmRuntimeCapabilityPreflight.present === true
      ? firstText(realRocmRuntimeCapabilityPreflight.status, realRocmRuntimeCapabilityPreflight.reason)
      : null;
  const hmrWaitDetail = realRocmCheckDetailJson(checks, 'real_repo_user_source_delta_hmr')
    ?? realRocmCheckDetailJson(checks, 'first_real_repo_ai_split_compile');
  const hmrProofValidation = compactObject(hmrWaitDetail?.gpu_proof_validation);
  const profileId = firstText(profile.id, json.profileId, json.profile_id, json.slug);
  const targetId = firstText(profileId, json.slug, json.target_name, json.targetName);
  const backend = backendFromVendorText(firstText(json.gpu_vendor, summary.gpu_vendor, json.backend))
    ?? firstText(json.backend)
    ?? 'unknown';
  const runMode = timingEvidence(
    json.timingMetrics,
    json.timing_metrics,
    summary.timings?.timingMetrics,
    summary.timings?.timing_metrics,
    summary.timings,
  );
  const visualPaths = compactStringList([
    ...(Array.isArray(json.visual_artifact_paths) ? json.visual_artifact_paths : []),
    ...(Array.isArray(json.visualArtifactPaths) ? json.visualArtifactPaths : []),
    ...(Array.isArray(summary.visual_artifact_paths) ? summary.visual_artifact_paths : []),
    ...(Array.isArray(summary.visualArtifactPaths) ? summary.visualArtifactPaths : []),
    ...artifactPathsFromValue(json.visualEvidenceArtifacts ?? json.visual_evidence_artifacts),
  ]);
  const visual = await visualArtifactEvidence(
    visualPaths,
    context.repoRoot,
    path.dirname(filePath),
    compactObject(json.visual_evidence_quality ?? json.visualEvidenceQuality),
    visualPaths.length > 0,
  );
  const outputOracleFacet = await realRocmLedgerOutputOracleFacet(
    ledger,
    proofLedger,
    visual,
    context.repoRoot,
    path.dirname(filePath),
  );
  const outputOrVisualOracleAccepted = outputOracleFacet.accepted === true;
  const nativeBoundaryRequiresAppHook = nativeBoundaryRequiresRealRocmAppHook({
    nativeRocmLaunchBoundary,
    realRocmRuntimeEligibility,
  });
  const appHookContractGate = realRocmAppHookContractGate({
    nativeBoundaryRequiresAppHook,
    realRocmAppHookContract,
    realRocmProfileProofObligations,
    realRocmProfile: profile,
  });
  const appHookContractAccepted = appHookContractGate.accepted === true;
  const runtimeCapabilityPreflightAccepted = realRocmRuntimeCapabilityPreflight.accepted !== false;
  const sidecarRuntimeBackendMismatch =
    realRocmSidecarRuntimeConsistencyGaps.includes('sidecar_runtime_backend_mismatch');
  const sidecarRuntimeConsistencyAccepted = !sidecarRuntimeBackendMismatch;
  const profileProofObligationsAccepted = realRocmProfileProofObligationsGaps.length === 0;
  const fullRuntimeProven = boolOrNull(
    json.fullRuntimeProven
    ?? json.full_runtime_proven
    ?? summary.fullRuntimeProven
    ?? summary.full_runtime_proven,
  );
  const gpuHmrSuccess = boolOrNull(
    json.gpuHmrSuccess
    ?? json.gpu_hmr_success
    ?? summary.gpuHmrSuccess
    ?? summary.gpu_hmr_success,
  );
  const accepted =
    gpuHmrSuccess === true
    && fullRuntimeProven === true
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && runtimeProofArtifactGate.accepted === true
    && outputOrVisualOracleAccepted === true
    && appHookContractAccepted === true
    && runtimeCapabilityPreflightAccepted === true
    && sidecarRuntimeConsistencyAccepted === true
    && profileProofObligationsAccepted === true
    && targetProgressionGateFailures.length === 0
    && realRocmFirewall.accepted === true;
  const strictRuntimeGateFailed =
    strictGates.accepted === false
    || strictGateFailures.length > 0
    || runtimeProofArtifactGate.present === false
    || runtimeProofArtifactGate.accepted === false;
  const proofStateMissing =
    hmrProofValidation.reason === 'proof_state_missing'
    || hmrProofValidation.satisfied === false
    || hmrWaitDetail?.wait_hmr_status === 'timeout';
  const refusalProven =
    !accepted
    && realRocmRequiredFullRuntimeProof(json)
    && gpuHmrSuccess !== true
    && fullRuntimeProven !== true
    && (strictRuntimeGateFailed || proofStateMissing);
  const matrixOutcome = accepted
    ? 'full_runtime_gpu_hmr'
    : refusalProven
      ? 'refusal_proven'
      : 'unproven';
  return finalizeRow({
    artifactSchema: firstText(json.schemaVersion, json.schema, 'synthi.gpu.hmr.real_rocm_repo_validation.v1'),
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId,
    profileId,
    proofMode: 'real_rocm_repo_validation',
    evidenceKind: accepted ? 'large_repo_output_oracle' : 'large_repo_runtime_refusal',
    matrixOutcome,
    acceptanceClass: accepted
      ? 'full_runtime_gpu_hmr'
      : refusalProven
        ? 'large_real_rocm_repo_refusal'
        : 'large_real_rocm_repo_unproven',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven,
    proofChainAccepted: accepted || refusalProven,
    proofChain: accepted
      ? 'real_rocm_full_runtime_ledger_oracle_chain'
      : refusalProven
        ? 'real_rocm_strict_runtime_refusal'
        : 'real_rocm_validation_unproven',
    proofIds: proofIdsFrom(
      json,
      summary,
      ledger,
      runtimeProofArtifactGate,
      proofIdFor('real-rocm-validation', {
        profileId,
        targetId,
        sourceUrl: firstText(json.source_url, json.sourceUrl),
        repoCommit: firstText(json.repo_commit, json.repoCommit),
        slug: firstText(json.slug),
      }),
    ),
    ledger,
    runtimeProofArtifact: runtimeProofArtifactGate,
    runtime_proof_artifact: runtimeProofArtifactGate,
    visual,
    outputOracleFacet,
    output_oracle_facet: outputOracleFacet,
    runMode,
    cpuHmrUsed: realRocmFirewall.cpuHmrUsed,
    cpu_hmr_used: realRocmFirewall.cpu_hmr_used,
    fullRebuildUsed: realRocmFirewall.fullRebuildUsed,
    full_rebuild_used: realRocmFirewall.full_rebuild_used,
    processRestarted: realRocmFirewall.processRestarted,
    process_restarted: realRocmFirewall.process_restarted,
    firewallEvidenceSource: realRocmFirewall.firewallEvidenceSource,
    firewall_evidence_source: realRocmFirewall.firewall_evidence_source,
    realRocmFirewall,
    real_rocm_firewall: realRocmFirewall,
    realRocm: {
      sourceUrl: firstText(json.source_url, json.sourceUrl),
      repoCommit: firstText(json.repo_commit, json.repoCommit),
      entryFile: firstText(json.entry_file, json.entryFile),
      deltaFile: firstText(json.delta_file, json.deltaFile),
      targetName: firstText(json.target_name, json.targetName),
      fileCount: finiteNumber(json.file_count ?? json.fileCount),
      seededFileCount: finiteNumber(json.seeded_file_count ?? json.seededFileCount),
      skippedFileCount: finiteNumber(json.skipped_file_count ?? json.skippedFileCount),
    },
    outputOracleResolution,
    targetProgression,
    realRocmProfileProofObligations,
    real_rocm_profile_proof_obligations: realRocmProfileProofObligations,
    targetProgressionGates,
    nativeRocmLaunchBoundary,
    native_rocm_launch_boundary: nativeRocmLaunchBoundary,
    realRocmRuntimeEligibility,
    real_rocm_runtime_eligibility: realRocmRuntimeEligibility,
    realRocmAppHookContract,
    real_rocm_app_hook_contract: realRocmAppHookContract,
    realRocmAppHookContractGate: appHookContractGate,
    real_rocm_app_hook_contract_gate: appHookContractGate,
    realRocmDeviceSidecarContract,
    real_rocm_device_sidecar_contract: realRocmDeviceSidecarContract,
    realRocmSidecarRuntimeConsistency,
    real_rocm_sidecar_runtime_consistency: realRocmSidecarRuntimeConsistency,
    realRocmCompileBridge,
    real_rocm_compile_bridge: realRocmCompileBridge,
    realRocmRuntimeCapabilityPreflight,
    real_rocm_runtime_capability_preflight: realRocmRuntimeCapabilityPreflight,
    timings: compactObject(runMode.present ? json.timingMetrics ?? json.timing_metrics ?? summary.timings?.timingMetrics : {}),
    reasons: compactStringList([
      ...strictGateFailures,
      ...runtimeProofArtifactGate.failedGates.map((failure) => failure.code),
      ...targetProgressionGateFailures.map((gate) => `target_progression_gate_failed:${text(gate.name) ?? 'unnamed'}`),
      ...outputOracleFacet.failedGates.map((failure) => failure.code),
      nativeRocmBoundaryReason ? `native_rocm_launch_boundary:${nativeRocmBoundaryReason}` : null,
      ...nativeRocmBoundaryGaps.map((gap) => `native_rocm_launch_boundary:${gap}`),
      realRocmRuntimeEligibilityReason ? `real_rocm_runtime_eligibility:${realRocmRuntimeEligibilityReason}` : null,
      ...realRocmRuntimeEligibilityGaps.map((gap) => `real_rocm_runtime_eligibility:${gap}`),
      realRocmProfileProofObligationsReason ? `real_rocm_profile_proof_obligations:${realRocmProfileProofObligationsReason}` : null,
      ...realRocmProfileProofObligationsGaps.map((gap) => `real_rocm_profile_proof_obligations:${gap}`),
      realRocmAppHookContractReason ? `real_rocm_app_hook_contract:${realRocmAppHookContractReason}` : null,
      ...realRocmAppHookContractGaps.map((gap) => `real_rocm_app_hook_contract:${gap}`),
      ...appHookContractGate.failedGaps,
      !accepted && realRocmDeviceSidecarContractReason
        ? `real_rocm_device_sidecar_contract:${realRocmDeviceSidecarContractReason}`
        : null,
      ...(!accepted ? realRocmDeviceSidecarContractGaps.map((gap) => `real_rocm_device_sidecar_contract:${gap}`) : []),
      !accepted && realRocmSidecarRuntimeConsistencyReason
        ? `real_rocm_sidecar_runtime_consistency:${realRocmSidecarRuntimeConsistencyReason}`
        : null,
      ...(!accepted ? realRocmSidecarRuntimeConsistencyGaps.map((gap) => `real_rocm_sidecar_runtime_consistency:${gap}`) : []),
      realRocmCompileBridgeReason ? `real_rocm_compile_bridge:${realRocmCompileBridgeReason}` : null,
      ...realRocmCompileBridgeGaps.map((gap) => `real_rocm_compile_bridge:${gap}`),
      realRocmRuntimeCapabilityPreflightReason
        ? `real_rocm_runtime_capability_preflight:${realRocmRuntimeCapabilityPreflightReason}`
        : null,
      ...realRocmRuntimeCapabilityPreflightGaps.map((gap) =>
        `real_rocm_runtime_capability_preflight:${gap}`
      ),
      ...(Array.isArray(ledger.failedInvariants) ? ledger.failedInvariants.map((failure) => failure.code) : []),
      ...realRocmFirewall.failedGates.map((failure) => failure.code),
      hmrProofValidation.reason,
      outputOrVisualOracleAccepted ? null : 'output_or_visual_oracle_proof_missing',
      appHookContractAccepted ? null : 'real_rocm_app_hook_contract_required_not_proven',
      runtimeCapabilityPreflightAccepted ? null : 'real_rocm_runtime_capability_preflight_not_proven',
      sidecarRuntimeConsistencyAccepted ? null : 'real_rocm_sidecar_runtime_consistency_not_proven',
      profileProofObligationsAccepted ? null : 'real_rocm_profile_proof_obligations_not_met',
      realRocmFirewall.accepted ? null : 'real_rocm_cpu_gpu_firewall_not_proven',
      ledger.present === true ? null : 'proof_ledger_record_missing',
      realRocmRequiredFullRuntimeProof(json) ? null : 'full_runtime_proof_not_required_by_artifact',
    ]),
    openGaps: accepted ? [] : compactStringList([
      runtimeProofArtifactGate.accepted === true ? null : 'strict_runtime_proof_artifact_required',
      ledger.gpuHmrSuccess === true ? null : 'proof_ledger_success_required',
      outputOrVisualOracleAccepted ? null : 'output_or_visual_oracle_proof_required',
      appHookContractAccepted ? null : 'real_rocm_app_hook_contract_required',
      ...appHookContractGate.failedGaps,
      runtimeCapabilityPreflightAccepted ? null : 'real_rocm_runtime_capability_preflight_failed',
      sidecarRuntimeConsistencyAccepted ? null : 'real_rocm_sidecar_runtime_consistency_required',
      profileProofObligationsAccepted ? null : 'real_rocm_profile_proof_obligations_required',
      realRocmFirewall.accepted ? null : 'real_rocm_cpu_gpu_firewall_required',
      proofStateMissing ? 'gpu_hmr_full_runtime_proof_state_missing' : null,
      targetProgressionGateFailures.length > 0 ? 'target_progression_gates_failed' : null,
      ...nativeRocmBoundaryGaps.map((gap) => `native_rocm_launch_boundary:${gap}`),
      ...realRocmRuntimeEligibilityGaps.map((gap) => `real_rocm_runtime_eligibility:${gap}`),
      ...realRocmProfileProofObligationsGaps.map((gap) => `real_rocm_profile_proof_obligations:${gap}`),
      ...realRocmAppHookContractGaps.map((gap) => `real_rocm_app_hook_contract:${gap}`),
      ...realRocmDeviceSidecarContractGaps.map((gap) => `real_rocm_device_sidecar_contract:${gap}`),
      ...realRocmSidecarRuntimeConsistencyGaps.map((gap) => `real_rocm_sidecar_runtime_consistency:${gap}`),
      ...realRocmCompileBridgeGaps.map((gap) => `real_rocm_compile_bridge:${gap}`),
      ...realRocmRuntimeCapabilityPreflightGaps.map((gap) =>
        `real_rocm_runtime_capability_preflight:${gap}`
      ),
      ...realRocmFirewall.failedGates.map((failure) => `real_rocm_cpu_gpu_firewall:${failure.code}`),
    ]),
  });
}

async function agentSplitRunModeProofRow(json, filePath, context) {
  const schema = firstText(
    json.schemaVersion,
    json.schema,
    'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  );
  const genericRuntimeRunMode = schema === 'synthi.gpu.hmr.runtime_run_mode_proof.v1';
  const runMode = timingEvidence(
    json.runMode,
    json.run_mode,
    json.timingMetrics,
    json.timing_metrics,
    json.timings,
  );
  const backend = firstText(json.backend, json.contract?.backend?.value, json.contract?.backend) ?? 'unknown';
  const targetId = firstText(
    json.targetId,
    json.target_id,
    json.contract?.projectId,
    json.contract?.project_id,
    json.acceptanceContract?.projectId,
    json.acceptanceContract?.project_id,
    json.acceptance_contract?.projectId,
    json.acceptance_contract?.project_id,
  ) ?? 'unknown';
  const fixtureId = firstText(
    json.fixtureId,
    json.fixture_id,
    json.validationProfileId,
    json.validation_profile_id,
  );
  const proofValidation = compactObject(json.gpuProofValidation ?? json.gpu_proof_validation ?? json.proofValidation);
  const ledgerValidation = compactObject(proofValidation.proofLedgerValidation);
  const runtimeValidation = compactObject(proofValidation.runtimeProofArtifactValidation);
  const runtimeProofArtifact = runtimeProofArtifactFromValue(json);
  const ledger = runModeLedgerFacet(json, runtimeProofArtifact);
  const runtimeProofArtifactGate = runtimeProofArtifactFacet(runtimeProofArtifact);
  const telemetry = compactObject(json.gpuProofTelemetry ?? json.gpu_proof_telemetry);
  const visualArtifacts = compactObject(json.visualArtifacts ?? json.visual_oracle_artifacts);
  const visualMetrics = compactObject(json.visualMetrics ?? json.visual_metrics ?? visualArtifacts);
  const visualRequired = true;
  const visual = await visualArtifactEvidence(
    artifactPathsFromValue(visualArtifacts),
    context.repoRoot,
    path.dirname(filePath),
    visualMetrics,
    visualRequired,
  );
  const metricScope = runMode.metricScope;
  const isCold = metricScope === 'cold';
  const cpuHmrUsed = boolOrNull(json.cpuHmrUsed ?? json.cpu_hmr_used);
  const fullRebuildUsed = boolOrNull(json.fullRebuildUsed ?? json.full_rebuild_used);
  const processRestarted = boolOrNull(json.processRestarted ?? json.process_restarted);
  const noCpuFallback = cpuHmrUsed === false;
  const noFullRebuild = fullRebuildUsed === false;
  const noRestart = processRestarted === false;
  const acceptedRuntime =
    !isCold
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && runtimeProofArtifactGate.accepted === true
    && visual.accepted === true
    && runMode.accepted === true
    && noCpuFallback
    && noFullRebuild
    && noRestart;
  const acceptedCold =
    isCold
    && (
      (json.coldSplitProven === true && json.cold_split_proven === true)
      || (
        genericRuntimeRunMode
        && json.coldRuntimeInitialProven === true
        && json.cold_runtime_initial_proven === true
      )
    )
    && visual.accepted === true
    && runMode.accepted === true
    && noCpuFallback
    && noFullRebuild
    && noRestart;
  const matrixOutcome = acceptedRuntime
    ? 'full_runtime_gpu_hmr'
    : acceptedCold
      ? 'cold_split_proven'
      : 'unproven';
  return finalizeRow({
    artifactSchema: schema,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId,
    profileId: firstText(fixtureId, json.profileId, json.profile_id, targetId === 'unknown' ? null : targetId) ?? 'unknown',
    fixtureId,
    fixture_id: fixtureId,
    proofMode: 'run_mode_proof',
    evidenceKind: isCold
      ? genericRuntimeRunMode
        ? 'cold_runtime_initial_visual_oracle'
        : 'cold_split_visual_oracle'
      : 'visual_oracle',
    matrixOutcome,
    acceptanceClass: acceptedRuntime
      ? 'full_runtime_gpu_hmr'
      : acceptedCold
        ? 'cold_split_visual_proof'
        : 'run_mode_proof_rejected',
    acceptedForGpuHmr: acceptedRuntime,
    gpuHmrSuccess: acceptedRuntime,
    refusalProven: false,
    proofChainAccepted: acceptedRuntime || acceptedCold,
    proofChain: acceptedRuntime
      ? 'embedded_runtime_proof_artifact_recomputed_ledger'
      : acceptedCold
        ? genericRuntimeRunMode
          ? 'runtime_initial_visual_gate'
          : 'mcp_initial_split_visual_gate'
        : 'run_mode_proof_rejected',
    proofIds: proofIdsFrom(
      json,
      ledger.proofId,
      runtimeProofArtifactGate.proofId,
      telemetry.proofId,
      telemetry.proof_id,
    ),
    coverageObligations: compactObject(
      json.coverageObligations
        ?? json.coverage_obligations
        ?? json.validationCoverage
        ?? json.validation_coverage,
    ),
    validationTargetScope: firstText(json.validationTargetScope, json.validation_target_scope),
    ledger,
    runtimeProofArtifact: runtimeProofArtifactGate,
    runtime_proof_artifact: runtimeProofArtifactGate,
    visual,
    runMode,
    cpuHmrUsed,
    fullRebuildUsed,
    processRestarted,
    timings: compactObject(json.timings),
    reasons: matrixOutcome === 'unproven' ? compactStringList([
      runMode.accepted ? null : 'run_mode_timing_not_accepted',
      visual.accepted ? null : 'visual_artifacts_not_readable',
      isCold || ledger.present ? null : 'embedded_proof_ledger_missing',
      isCold || ledger.source === 'recomputed_ledger' ? null : 'embedded_proof_ledger_not_recomputed',
      isCold || ledger.gpuHmrSuccess === true ? null : 'embedded_proof_ledger_not_accepted',
      isCold || runtimeProofArtifactGate.accepted === true ? null : 'runtime_proof_artifact_not_accepted',
      cpuHmrUsed === false ? null : 'cpu_hmr_firewall_field_not_false',
      fullRebuildUsed === false ? null : 'full_rebuild_firewall_field_not_false',
      processRestarted === false ? null : 'process_restart_firewall_field_not_false',
      targetId === 'unknown' ? 'target_identity_not_present_in_run_mode_artifact' : null,
      ...ledger.failedInvariants.map((failure) => failure.code),
      ...runtimeProofArtifactGate.failedGates.map((failure) => failure.code),
    ]) : [],
    openGaps: matrixOutcome === 'unproven' ? ['run_mode_proof_not_accepted'] : [],
  });
}

function agentSplitNegativeEditRefusalRow(json, filePath, context) {
  const runMode = timingEvidence(
    json.runMode,
    json.run_mode,
    json.timingMetrics,
    json.timing_metrics,
    json.timings,
  );
  const backend = firstText(json.backend, json.contract?.backend?.value, json.contract?.backend) ?? 'unknown';
  const targetId = firstText(
    json.targetId,
    json.target_id,
    json.contract?.projectId,
    json.contract?.project_id,
    json.acceptanceContract?.projectId,
    json.acceptanceContract?.project_id,
    json.acceptance_contract?.projectId,
    json.acceptance_contract?.project_id,
  ) ?? 'unknown';
  const fixtureId = firstText(
    json.fixtureId,
    json.fixture_id,
    json.validationProfileId,
    json.validation_profile_id,
  );
  const reasons = compactStringList([
    ...(Array.isArray(json.reasons) ? json.reasons : []),
    ...(Array.isArray(json.unsupportedReasons) ? json.unsupportedReasons : []),
    ...(Array.isArray(json.unsupported_reasons) ? json.unsupported_reasons : []),
    firstText(json.reason),
  ]);
  const refusalProven =
    json.gpuHmrSuccess === false
    && json.gpu_hmr_success !== true
    && json.acceptedForGpuHmr !== true
    && json.accepted_for_gpu_hmr !== true
    && reasons.length > 0;
  return finalizeRow({
    artifactSchema: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId,
    profileId: firstText(fixtureId, json.profileId, json.profile_id, targetId),
    fixtureId,
    fixture_id: fixtureId,
    proofMode: 'negative_edit',
    evidenceKind: 'negative_edit',
    matrixOutcome: refusalProven ? 'refusal_proven' : 'unproven',
    acceptanceClass: refusalProven ? 'negative_edit_refusal' : 'negative_edit_refusal_unproven',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    refusalProven,
    proofChainAccepted: refusalProven,
    proofChain: refusalProven ? 'structured_negative_edit_refusal' : 'negative_edit_refusal_unproven',
    proofIds: proofIdsFrom(json),
    ledger: {
      present: false,
      proofId: null,
      gpuHmrSuccess: false,
      failedInvariants: [],
    },
    visual: {
      required: false,
      present: false,
      accepted: true,
      imageCount: 0,
      existingImageCount: 0,
      pngImageCount: 0,
      allImagesExist: false,
      allImagesArePng: false,
      images: [],
    },
    runMode,
    cpuHmrUsed: boolOrNull(json.cpuHmrUsed ?? json.cpu_hmr_used) ?? false,
    fullRebuildUsed: boolOrNull(json.fullRebuildUsed ?? json.full_rebuild_used) ?? false,
    processRestarted: boolOrNull(json.processRestarted ?? json.process_restarted) ?? false,
    timings: compactObject(json.timings),
    reasons,
    openGaps: refusalProven ? [] : ['negative_edit_refusal_not_proven'],
  });
}

async function classifyJsonArtifact(json, filePath, context) {
  if (Array.isArray(json) && json.every((record) => isObject(record) && 'name' in record && 'status' in record)) {
    return agentSplitRow(json, filePath, context);
  }
  if (!isObject(json)) return null;
  const schema = firstText(json.schemaVersion, json.schema) ?? '';
  const proofId = firstText(json.proofId, json.proof_id) ?? '';
  if (
    schema === 'synthi.gpu_hmr.generated_split_granularity.v1'
    && isObject(json.deterministicFissionVerifier ?? json.deterministic_fission_verifier)
  ) {
    return generatedSplitFissionRow(json, filePath, context);
  }
  if (schema === 'synthi.gpu.hmr.proof.v1') return runtimeProofRow(json, filePath, context);
  if (schema === 'synthi.hiprt.warm_visual_proof.v2') return hiprtWarmRow(json, filePath, context);
  if (schema === 'synthi.gpu.hmr.external_project_profile.report.v1') {
    return externalProjectRow(json, filePath, context);
  }
  if (schema === 'synthi.gpu.hmr.external_project_rejection.v1') {
    return externalProjectRejectionRow(json, filePath, context);
  }
  if (
    schema === 'synthi.gpu.hmr.agent_split_run_mode_proof.v1'
    || schema === 'synthi.gpu.hmr.runtime_run_mode_proof.v1'
  ) {
    return agentSplitRunModeProofRow(json, filePath, context);
  }
  if (schema === 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1') {
    return agentSplitNegativeEditRefusalRow(json, filePath, context);
  }
  if (isObject(json.real_rocm_profile ?? json.realRocmProfile) && Array.isArray(json.checks)) {
    return realRocmRepoValidationRow(json, filePath, context);
  }
  if (schema.includes('webgpu_runtime_visual_proof') || proofId.startsWith('webgpu-runtime-visual-proof:')) {
    return webGpuRuntimeVisualRow(json, filePath, context);
  }
  if (schema.includes('webgpu_runtime_compute_proof') || proofId.startsWith('webgpu-runtime-compute-proof:')) {
    return webGpuRuntimeComputeRow(json, filePath, context);
  }
  if (schema.includes('hip_module_runtime_proof') || proofId.startsWith('hip-module-runtime-proof:')) {
    return hipModuleRuntimeRow(json, filePath, context);
  }
  if (
    schema.includes('oidn_preflight')
    || schema.includes('opencl_preflight')
    || schema.includes('vulkan_preflight')
    || schema.includes('webgpu_preflight')
  ) {
    return preflightRow(json, filePath, context);
  }
  return null;
}

export async function walkJsonFiles(root) {
  if (!(await pathExists(root))) return [];
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        out.push(fullPath);
      }
    }
  }
  return out;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function defaultValidationMatrixRoots({ repoRoot, mcpRoot }) {
  return [
    path.join(mcpRoot, '.gpu-hmr-test-logs'),
    path.join(mcpRoot, '.gpu-hmr-test-artifacts'),
    path.join(repoRoot, 'tmp', 'validation-runs'),
    path.join(repoRoot, 'tmp', 'real-rocm'),
  ];
}

function rowPriority(row) {
  return MATRIX_OUTCOME_PRIORITY.get(row.matrixOutcome) ?? 0;
}

function selectBestRows(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = row.matrixKey;
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, row);
      continue;
    }
    const priorityDelta = rowPriority(row) - rowPriority(existing);
    if (priorityDelta > 0 || (priorityDelta === 0 && String(row.updatedAt) > String(existing.updatedAt))) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

function coverageSummary(rows) {
  const byOutcome = {};
  const byBackend = {};
  for (const row of rows) {
    byOutcome[row.matrixOutcome] = (byOutcome[row.matrixOutcome] ?? 0) + 1;
    byBackend[row.backend] = (byBackend[row.backend] ?? 0) + 1;
  }
  const fullRuntimeRows = rows.filter((row) => row.matrixOutcome === 'full_runtime_gpu_hmr');
  const visualProfileRows = rows.filter((row) => row.matrixOutcome === 'visual_profile_accepted');
  const refusalRows = rows.filter((row) => row.matrixOutcome === 'refusal_proven');
  const preflightRows = rows.filter((row) => row.matrixOutcome === 'preflight_only');
  const unprovenRows = rows.filter((row) => row.matrixOutcome === 'unproven');
  return {
    rowCount: rows.length,
    byOutcome,
    byBackend,
    acceptedFullRuntimeGpuHmrRows: fullRuntimeRows.length,
    acceptedFullRuntimeTargets: compactStringList(fullRuntimeRows.map((row) => row.targetId)),
    visualProfileAcceptedRows: visualProfileRows.length,
    visualProfileTargets: compactStringList(visualProfileRows.map((row) => row.targetId)),
    refusalProvenRows: refusalRows.length,
    refusalTargets: compactStringList(refusalRows.map((row) => row.targetId)),
    preflightOnlyRows: preflightRows.length,
    preflightOnlyTargets: compactStringList(preflightRows.map((row) => row.targetId)),
    unprovenRows: unprovenRows.length,
    unprovenTargets: compactStringList(unprovenRows.map((row) => row.targetId)),
    planCoverage: planCoverage(rows),
  };
}

function rowRefs(rows) {
  return rows.map((row) => ({
    rowId: row.rowId,
    backend: row.backend,
    targetId: row.targetId,
    matrixOutcome: row.matrixOutcome,
    proofChain: row.proofChain,
    proofIds: row.proofIds,
    runMode: row.runMode,
    validationTargetScope: row.validationTargetScope,
    coverageObligations: row.coverageObligations,
  }));
}

function coverageEntry({ id, requirement, status, rows = [], openGaps = [], ...extra }) {
  return compactObject({
    id,
    requirement,
    status,
    rowCount: rows.length,
    rows: rowRefs(rows),
    openGaps: compactStringList(openGaps),
    ...extra,
  });
}

function acceptedRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'full_runtime_gpu_hmr' && predicate(row));
}

function rowHasAcceptedVisualEvidence(row) {
  return row.visual?.present === true && row.visual?.accepted === true;
}

function refusalRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'refusal_proven' && predicate(row));
}

function preflightOnlyRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'preflight_only' && predicate(row));
}

function visualProfileRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'visual_profile_accepted' && predicate(row));
}

function deterministicFissionRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'deterministic_fission_proven' && predicate(row));
}

function normalizedRowIdentityValues(row) {
  return compactStringList([
    row.targetId,
    row.target_id,
    row.profileId,
    row.profile_id,
    row.fixtureId,
    row.fixture_id,
    row.artifactPath,
    row.artifact_path,
    ...(Array.isArray(row.proofIds) ? row.proofIds : []),
  ]).map((value) => value.toLowerCase());
}

function rowMatchesValidationProfile(row, profileId) {
  const expected = String(profileId ?? '').trim().toLowerCase();
  if (!expected) return false;
  return normalizedRowIdentityValues(row).some((value) =>
    value === expected
    || value.includes(`/${expected}/`)
    || value.includes(`\\${expected}\\`)
    || value.includes(`/${expected}-`)
    || value.includes(`\\${expected}-`)
    || value.includes(`-${expected}-`)
  );
}

function validationRunModeCoverage(rows) {
  const fullRuntimeRows = acceptedRows(rows, rowRequiresPerTargetRunModes);
  const coldRows = rows.filter((row) =>
    rowRequiresPerTargetRunModes(row)
    && row.matrixOutcome === 'cold_split_proven'
    && row.runMode?.accepted === true
    && row.runMode.metricScope === 'cold'
  );
  const rowsByTarget = new Map();
  for (const row of fullRuntimeRows) {
    const key = `${row.backend}:${row.targetId}`;
    rowsByTarget.set(key, [...(rowsByTarget.get(key) ?? []), row]);
  }
  const attachedColdRows = [];
  for (const row of coldRows) {
    const key = `${row.backend}:${row.targetId}`;
    if (rowsByTarget.has(key)) {
      rowsByTarget.set(key, [...rowsByTarget.get(key), row]);
      attachedColdRows.push(row);
    }
  }
  const negativeEditRows = refusalRows(rows, (row) =>
    row.proofMode === 'negative_edit'
    || row.evidenceKind === 'negative_edit'
    || row.runMode?.metricScope === 'negative_edit'
  );
  const attachedNegativeEditRows = [];
  for (const row of negativeEditRows) {
    const key = `${row.backend}:${row.targetId}`;
    if (rowsByTarget.has(key)) {
      rowsByTarget.set(key, [...rowsByTarget.get(key), row]);
      attachedNegativeEditRows.push(row);
    }
  }
  const openGaps = [];
  const targetCoverage = [];
  for (const [targetKey, targetRows] of rowsByTarget) {
    const targetGaps = [];
    for (const requiredMode of REQUIRED_FULL_TARGET_RUN_MODES) {
      const hasMode = targetRows.some((row) =>
        row.runMode?.accepted === true && row.runMode.metricScope === requiredMode
      );
      if (!hasMode) targetGaps.push(`${targetKey}:${requiredMode}_evidence_missing`);
    }
    const hotDelta1EditHashes = new Set(targetRows
      .filter((row) => row.runMode?.accepted === true && row.runMode.metricScope === 'hot_delta_1')
      .map((row) => text(row.runMode?.editHash ?? row.runMode?.edit_hash))
      .filter(Boolean));
    const hasHotDelta2DifferentEdit = targetRows.some((row) =>
      row.runMode?.accepted === true
      && row.runMode.metricScope === 'hot_delta_2'
      && hotDelta1EditHashes.size > 0
      && text(row.runMode.editHash ?? row.runMode.edit_hash)
      && !hotDelta1EditHashes.has(text(row.runMode.editHash ?? row.runMode.edit_hash))
      && (
        row.runMode.differentEdit === true
        || row.runMode.different_edit === true
        || row.runMode.editKind === 'different_gpu_edit'
        || row.runMode.edit_kind === 'different_gpu_edit'
      )
    );
    if (!hasHotDelta2DifferentEdit) {
      targetGaps.push(`${targetKey}:hot_delta_2_different_edit_evidence_missing`);
    }
    const hasNegativeEditRefusal = targetRows.some((row) =>
      row.matrixOutcome === 'refusal_proven'
      && (
        row.proofMode === 'negative_edit'
        || row.evidenceKind === 'negative_edit'
        || row.runMode?.editKind === 'negative_edit'
        || row.runMode?.edit_kind === 'negative_edit'
        || row.runMode?.metricScope === 'negative_edit'
      )
    );
    if (!hasNegativeEditRefusal) {
      targetGaps.push(`${targetKey}:negative_edit_refusal_evidence_missing`);
    }
    openGaps.push(...targetGaps);
    const [backend, ...targetIdParts] = targetKey.split(':');
    targetCoverage.push({
      targetKey,
      backend,
      targetId: targetIdParts.join(':'),
      status: targetGaps.length === 0 ? 'accepted' : 'missing',
      rowCount: targetRows.length,
      rows: rowRefs(targetRows),
      openGaps: compactStringList(targetGaps),
    });
  }
  if (fullRuntimeRows.length > 0 && attachedNegativeEditRows.length === 0) {
    openGaps.push('negative_edit_refusal_evidence_missing');
  }
  const acceptedTargetCount = targetCoverage.filter((entry) => entry.status === 'accepted').length;
  const incompleteTargetCount = targetCoverage.filter((entry) => entry.status !== 'accepted').length;
  const status = fullRuntimeRows.length === 0
    ? 'missing'
    : openGaps.length === 0
      ? 'accepted'
      : acceptedTargetCount > 0
        ? 'partial'
        : 'missing';
  return coverageEntry({
    id: 'per_target_run_modes',
    requirement: 'Per-target cold split, hot delta 1, hot delta 2 with a different edit, and negative-edit evidence',
    status,
    rows: [...fullRuntimeRows, ...attachedColdRows, ...attachedNegativeEditRows],
    openGaps,
    targetCoverage,
    acceptedTargetCount,
    incompleteTargetCount,
  });
}

function backendRunModeCoverage({ rows, backend, id, requirement, missingGap }) {
  const fullRuntimeRows = acceptedRows(rows, (row) => row.backend === backend);
  if (fullRuntimeRows.length === 0) {
    return coverageEntry({
      id,
      requirement,
      status: 'missing',
      openGaps: [missingGap],
    });
  }

  const rowsByTarget = new Map();
  for (const row of fullRuntimeRows) {
    const key = `${row.backend}:${row.targetId}`;
    rowsByTarget.set(key, [...(rowsByTarget.get(key) ?? []), row]);
  }

  const targetKeys = new Set(rowsByTarget.keys());
  const fullRuntimeRowIds = new Set(fullRuntimeRows.map((row) => row.rowId));
  const supportRows = rows.filter((row) =>
    row.backend === backend
    && !fullRuntimeRowIds.has(row.rowId)
    && row.runMode?.accepted === true
    && targetKeys.has(`${row.backend}:${row.targetId}`)
  );
  for (const row of supportRows) {
    const key = `${row.backend}:${row.targetId}`;
    rowsByTarget.set(key, [...(rowsByTarget.get(key) ?? []), row]);
  }

  const openGaps = [];
  const targetCoverage = [];
  for (const [targetKey, targetRows] of rowsByTarget) {
    const targetGaps = [];
    for (const requiredMode of REQUIRED_FULL_TARGET_RUN_MODES) {
      const hasMode = targetRows.some((row) =>
        row.runMode?.accepted === true && row.runMode.metricScope === requiredMode
      );
      if (!hasMode) targetGaps.push(`${targetKey}:${requiredMode}_evidence_missing`);
    }

    const hotDelta1EditHashes = new Set(targetRows
      .filter((row) => row.runMode?.accepted === true && row.runMode.metricScope === 'hot_delta_1')
      .map((row) => text(row.runMode?.editHash ?? row.runMode?.edit_hash))
      .filter(Boolean));
    const hasHotDelta2DifferentEdit = targetRows.some((row) =>
      row.runMode?.accepted === true
      && row.runMode.metricScope === 'hot_delta_2'
      && hotDelta1EditHashes.size > 0
      && text(row.runMode.editHash ?? row.runMode.edit_hash)
      && !hotDelta1EditHashes.has(text(row.runMode.editHash ?? row.runMode.edit_hash))
      && (
        row.runMode.differentEdit === true
        || row.runMode.different_edit === true
        || row.runMode.editKind === 'different_gpu_edit'
        || row.runMode.edit_kind === 'different_gpu_edit'
      )
    );
    if (!hasHotDelta2DifferentEdit) {
      targetGaps.push(`${targetKey}:hot_delta_2_different_edit_evidence_missing`);
    }

    const hasNegativeEditRefusal = targetRows.some((row) =>
      row.matrixOutcome === 'refusal_proven'
      && (
        row.proofMode === 'negative_edit'
        || row.evidenceKind === 'negative_edit'
        || row.runMode?.editKind === 'negative_edit'
        || row.runMode?.edit_kind === 'negative_edit'
        || row.runMode?.metricScope === 'negative_edit'
      )
    );
    if (!hasNegativeEditRefusal) {
      targetGaps.push(`${targetKey}:negative_edit_refusal_evidence_missing`);
    }

    openGaps.push(...targetGaps);
    const [targetBackend, ...targetIdParts] = targetKey.split(':');
    targetCoverage.push({
      targetKey,
      backend: targetBackend,
      targetId: targetIdParts.join(':'),
      status: targetGaps.length === 0 ? 'accepted' : 'partial',
      rowCount: targetRows.length,
      rows: rowRefs(targetRows),
      openGaps: compactStringList(targetGaps),
    });
  }

  return coverageEntry({
    id,
    requirement,
    status: openGaps.length === 0 ? 'accepted' : 'partial',
    rows: [...new Set([...fullRuntimeRows, ...supportRows])],
    openGaps,
    targetCoverage,
    acceptedTargetCount: targetCoverage.filter((entry) => entry.status === 'accepted').length,
    incompleteTargetCount: targetCoverage.filter((entry) => entry.status !== 'accepted').length,
  });
}

function acceptedOrRefusedCoverage({ rows, id, requirement, acceptedPredicate, refusalPredicate, missingGap }) {
  const accepted = acceptedRows(rows, acceptedPredicate);
  if (accepted.length > 0) {
    return coverageEntry({ id, requirement, status: 'accepted', rows: accepted });
  }
  const refused = refusalRows(rows, refusalPredicate ?? acceptedPredicate);
  if (refused.length > 0) {
    return coverageEntry({
      id,
      requirement,
      status: 'refused',
      rows: refused,
      openGaps: compactStringList(refused.flatMap((row) => row.openGaps)),
    });
  }
  return coverageEntry({
    id,
    requirement,
    status: 'missing',
    openGaps: [missingGap],
  });
}

function planCoverage(rows) {
  const flowRows = acceptedRows(rows, (row) =>
    row.backend === 'hip'
    && rowMatchesValidationProfile(row, 'flow')
    && rowHasAcceptedVisualEvidence(row)
  );
  const rayRows = acceptedRows(rows, (row) =>
    row.backend === 'hip'
    && rowMatchesValidationProfile(row, 'ray-light')
    && rowHasAcceptedVisualEvidence(row)
  );
  const hipRuntimeRows = acceptedRows(rows, (row) =>
    row.backend === 'hip'
    && row.proofMode !== 'hip_module_runtime_readback'
  );
  const hipModuleRuntimeRows = acceptedRows(rows, (row) =>
    row.backend === 'hip'
    && row.proofMode === 'hip_module_runtime_readback'
    && row.supportedPipelineScope === 'explicit-hip-module-float32-readback'
  );
  const hiprtRows = acceptedRows(rows, (row) => row.backend === 'hiprt');
  const webgpuRuntimeRows = acceptedRows(rows, (row) => row.backend === 'webgpu');
  const webgpuComputeRows = acceptedRows(rows, (row) =>
    row.backend === 'webgpu'
    && row.proofMode === 'webgpu_wgsl_runtime_compute'
    && row.outputOracleFacet?.kind === 'compute_oracle'
    && row.outputOracleFacet?.accepted === true
  );
  const webgpuEmptyLayoutRows = acceptedRows(rows, (row) =>
    row.backend === 'webgpu'
    && row.supportedPipelineScope === 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list'
  );
  const webgpuProfiledLayoutRows = acceptedRows(rows, (row) =>
    row.backend === 'webgpu'
    && row.supportedPipelineScope === 'explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list'
    && row.runtimeResourceTrace?.resourceStateHash
    && row.runtimeResourceTrace?.bindGroupCount > 0
    && row.runtimeResourceTrace?.vertexBufferCount > 0
  );
  const webgpuPreflightRows = preflightOnlyRows(rows, (row) => row.backend === 'webgpu');
  const externalVisualRows = visualProfileRows(rows, (row) => row.backend === 'webgl');
  const fissionRows = deterministicFissionRows(rows, () => true);

  return [
    coverageEntry({
      id: 'rocm_hip_full_runtime',
      requirement: 'ROCm/HIP full-runtime proof-ledger acceptance',
      status: hipRuntimeRows.length > 0 ? 'accepted' : 'missing',
      rows: hipRuntimeRows,
      openGaps: hipRuntimeRows.length > 0 ? [] : ['hip_full_runtime_ledger_required'],
    }),
    coverageEntry({
      id: 'hip_module_scoped_runtime_readback',
      requirement: 'Scoped HIP module-load/runtime readback proof',
      status: hipModuleRuntimeRows.length > 0 ? 'accepted' : 'missing',
      rows: hipModuleRuntimeRows,
      openGaps: hipModuleRuntimeRows.length > 0 ? [] : ['hip_module_runtime_readback_required'],
    }),
    coverageEntry({
      id: 'flow_visual_gpu_path',
      requirement: 'Flow visual GPU path with runtime proof and visual oracle',
      status: flowRows.length > 0 ? 'accepted' : 'missing',
      rows: flowRows,
      openGaps: flowRows.length > 0 ? [] : ['flow_visual_runtime_proof_required'],
    }),
    coverageEntry({
      id: 'ray_light_visual_gpu_path',
      requirement: 'Ray-light visual GPU path with runtime proof and visual oracle',
      status: rayRows.length > 0 ? 'accepted' : 'missing',
      rows: rayRows,
      openGaps: rayRows.length > 0 ? [] : ['ray_light_visual_runtime_proof_required'],
    }),
    coverageEntry({
      id: 'hiprt_visual_path',
      requirement: 'HIPRT same-process ray-traced visual path',
      status: hiprtRows.length > 0 ? 'accepted' : 'missing',
      rows: hiprtRows,
      openGaps: hiprtRows.length > 0 ? [] : ['hiprt_visual_runtime_proof_required'],
    }),
    backendRunModeCoverage({
      rows,
      backend: 'hiprt',
      id: 'hiprt_run_modes',
      requirement: 'HIPRT cold split, hot delta 1, hot delta 2 with a different edit, and negative-edit evidence',
      missingGap: 'hiprt_run_mode_proof_required',
    }),
    coverageEntry({
      id: 'webgpu_scoped_runtime_visual',
      requirement: 'Scoped WebGPU WGSL shader/pipeline runtime visual proof',
      status: webgpuRuntimeRows.length > 0 ? 'accepted' : 'missing',
      rows: webgpuRuntimeRows,
      openGaps: webgpuRuntimeRows.length > 0 ? [] : ['webgpu_runtime_visual_proof_required'],
    }),
    coverageEntry({
      id: 'webgpu_empty_layout_runtime_visual',
      requirement: 'WebGPU empty-layout WGSL render proof with deterministic visual oracle',
      status: webgpuEmptyLayoutRows.length > 0 ? 'accepted' : 'missing',
      rows: webgpuEmptyLayoutRows,
      openGaps: webgpuEmptyLayoutRows.length > 0 ? [] : ['webgpu_empty_layout_runtime_visual_required'],
    }),
    coverageEntry({
      id: 'webgpu_profiled_layout_runtime_visual',
      requirement: 'WebGPU profiled pipeline layout proof with uniform bind group and vertex buffer runtime traces',
      status: webgpuProfiledLayoutRows.length > 0 ? 'accepted' : 'missing',
      rows: webgpuProfiledLayoutRows,
      openGaps: webgpuProfiledLayoutRows.length > 0 ? [] : ['webgpu_profiled_layout_runtime_visual_required'],
    }),
    coverageEntry({
      id: 'webgpu_compute_runtime_readback',
      requirement: 'WebGPU compute pipeline proof with raw readback-backed compute oracle',
      status: webgpuComputeRows.length > 0 ? 'accepted' : 'missing',
      rows: webgpuComputeRows,
      openGaps: webgpuComputeRows.length > 0 ? [] : ['webgpu_compute_runtime_readback_required'],
    }),
    coverageEntry({
      id: 'webgpu_runtime_preflight',
      requirement: 'WebGPU runtime capability preflight without shader/pipeline overclaim',
      status: webgpuPreflightRows.length > 0 ? 'preflight_only' : 'missing',
      rows: webgpuPreflightRows,
      openGaps: webgpuPreflightRows.length > 0
        ? compactStringList(webgpuPreflightRows.flatMap((row) => row.openGaps))
        : ['webgpu_runtime_preflight_required'],
    }),
    coverageEntry({
      id: 'external_engine_visual_profile',
      requirement: 'At least one larger external engine-style visual profile',
      status: externalVisualRows.length > 0 ? 'visual_profile_only' : 'missing',
      rows: externalVisualRows,
      openGaps: externalVisualRows.length > 0
        ? compactStringList(externalVisualRows.flatMap((row) => row.openGaps))
        : ['external_engine_visual_profile_required'],
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'large_real_rocm_repo',
      requirement: 'Large real ROCm repository validation with full-runtime proof gating',
      acceptedPredicate: (row) => row.proofMode === 'real_rocm_repo_validation',
      missingGap: 'large_real_rocm_repo_validation_required',
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'bevy_file_loaded_wgsl',
      requirement: 'Bevy file-loaded WGSL full-runtime proof',
      acceptedPredicate: (row) => row.backend === 'bevy_wgsl',
      missingGap: 'bevy_full_runtime_ledger_required',
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'oidn_hip_output',
      requirement: 'OIDN HIP output proof on ROCm-compatible runtime',
      acceptedPredicate: (row) => row.backend === 'oidn_hip',
      missingGap: 'oidn_hip_runtime_proof_required',
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'opencl_dispatch_readback',
      requirement: 'OpenCL dispatch/event/readback output proof',
      acceptedPredicate: (row) => row.backend === 'opencl',
      missingGap: 'opencl_dispatch_readback_proof_required',
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'vulkan_pipeline_frame',
      requirement: 'Vulkan pipeline-layout, command-buffer, and frame-output proof',
      acceptedPredicate: (row) => row.backend === 'vulkan',
      missingGap: 'vulkan_pipeline_frame_proof_required',
    }),
    acceptedOrRefusedCoverage({
      rows,
      id: 'cuda_runtime',
      requirement: 'CUDA runtime proof on CUDA hardware',
      acceptedPredicate: (row) => row.backend === 'cuda',
      missingGap: 'cuda_hardware_required',
    }),
    coverageEntry({
      id: 'per_kernel_smallest_safe_fission',
      requirement: 'Per-kernel or smallest-safe fission verifier proof',
      status: fissionRows.length > 0 ? 'accepted' : 'missing',
      rows: fissionRows,
      openGaps: fissionRows.length > 0 ? [] : ['deterministic_smallest_safe_fission_verifier_required'],
    }),
    validationRunModeCoverage(rows),
  ];
}

export function queryGpuHmrValidationMatrixLedger(ledger = {}) {
  const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
  const failures = [];
  if (ledger.schemaVersion !== GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION) {
    failures.push({
      code: 'validation_matrix_schema_mismatch',
      suppliedSchemaVersion: ledger.schemaVersion ?? null,
    });
  }
  if (rows.length === 0) {
    failures.push({ code: 'validation_matrix_rows_empty' });
  }
  rows.forEach((row, index) => {
    if (row.schemaVersion !== GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION) {
      failures.push({ code: 'validation_matrix_row_schema_mismatch', row_index: index });
    }
    for (const failure of rowSafetyFailures(row)) {
      failures.push({ ...failure, row_index: index, targetId: row.targetId });
    }
    if (row.safety?.accepted === false) {
      for (const failure of row.safety.failedGates ?? []) {
        failures.push({ ...failure, row_index: index, targetId: row.targetId });
      }
    }
  });
  const recomputedProofId = proofIdFor('gpu-validation-matrix-ledger', {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    rows: rows.map((row) => row.rowId),
    summary: ledger.summary,
  });
  if (ledger.proofId && ledger.proofId !== recomputedProofId) {
    failures.push({
      code: 'validation_matrix_proof_id_mismatch',
      suppliedProofId: ledger.proofId,
      recomputedProofId,
    });
  }
  return {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    proofId: recomputedProofId,
    accepted: failures.length === 0,
    failedGates: failures,
    summary: ledger.summary ?? coverageSummary(rows),
  };
}

export function buildGpuHmrValidationMatrixLedger(rows, options = {}) {
  const selectedRows = options.latestPerTarget === false ? rows : selectBestRows(rows);
  const includedRows = options.includeUnproven === true
    ? selectedRows
    : selectedRows.filter((row) => row.matrixOutcome !== 'unproven');
  const omittedUnprovenRows = selectedRows.length - includedRows.length;
  includedRows.sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
  const summary = {
    ...coverageSummary(includedRows),
    includeUnproven: options.includeUnproven === true,
    omittedUnprovenRows,
  };
  const seed = {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    latestPerTarget: options.latestPerTarget !== false,
    includeUnproven: options.includeUnproven === true,
    sourceRoots: options.sourceRoots ?? [],
    summary,
    rows: includedRows,
  };
  const proofId = proofIdFor('gpu-validation-matrix-ledger', {
    schemaVersion: seed.schemaVersion,
    rows: includedRows.map((row) => row.rowId),
    summary,
  });
  const ledger = {
    ...seed,
    proofId,
  };
  return {
    ...ledger,
    query: queryGpuHmrValidationMatrixLedger(ledger),
  };
}

export async function collectGpuHmrValidationMatrixLedger(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const mcpRoot = path.resolve(options.mcpRoot ?? path.join(repoRoot, 'mcp', 'synthi-mcp'));
  const roots = options.roots ?? defaultValidationMatrixRoots({ repoRoot, mcpRoot });
  const files = [];
  for (const root of roots) {
    files.push(...await walkJsonFiles(path.resolve(root)));
  }
  const rows = [];
  for (const filePath of files) {
    if (options.includeInvalidated !== true && filePath.split(path.sep).includes('invalidated')) continue;
    const json = await readJson(filePath);
    if (json === null) continue;
    const stat = await fs.stat(filePath);
    const row = await classifyJsonArtifact(json, filePath, {
      repoRoot,
      mcpRoot,
      updatedAt: stat.mtime.toISOString(),
    });
    if (row) rows.push(row);
  }
  return buildGpuHmrValidationMatrixLedger(rows, {
    latestPerTarget: options.latestPerTarget !== false,
    includeUnproven: options.includeUnproven === true,
    sourceRoots: roots.map((root) => relPath(root, repoRoot)),
    generatedAt: options.generatedAt,
  });
}
