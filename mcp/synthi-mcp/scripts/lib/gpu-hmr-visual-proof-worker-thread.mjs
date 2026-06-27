import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';
import sharp from 'sharp';
import {
  stableJson,
  sha256Bytes,
  sha256Text,
  validateArtifactCasManifest,
} from './gpu-hmr-artifact-cas.mjs';
import {
  GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  computeVisualWorkerExecutableIdentity,
} from './gpu-hmr-visual-proof-worker.mjs';

let activeWorkerIdentity = null;
let cachedWorkerIdentity = null;

if (!isMainThread) {
  runWorker(workerData?.request ?? {}, workerData?.options ?? {})
    .then((result) => postWorkerResult(result))
    .catch((error) => postWorkerResult(failResult('visual_worker_uncaught_error', {
      message: error?.message ?? String(error),
    })));
}

export async function analyzeVisualProofRequest(request = {}, options = {}) {
  return runWorker(request, options);
}

async function runWorker(request, options) {
  const startedAt = Date.now();
  const reasons = [];
  const gaps = [];
  const allowedRoots = Array.isArray(options.allowedRoots) ? options.allowedRoots : [];
  const allowedOutputRoots = Array.isArray(options.allowedOutputRoots) ? options.allowedOutputRoots : [];
  activeWorkerIdentity = await currentVisualWorkerIdentity();

  if (request?.schemaVersion && request.schemaVersion !== GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION) {
    reasons.push('visual_worker_schema_invalid');
  }
  const expectedWorkerExecutableHash = text(
    options.expectedWorkerExecutableHash
    ?? request.expectedWorkerExecutableHash
    ?? request.expected_worker_executable_hash,
  );
  if (!activeWorkerIdentity.executableHash) {
    reasons.push('visual_worker_executable_hash_missing');
    gaps.push('visual_worker_executable_hash_missing');
  } else if (
    expectedWorkerExecutableHash
    && expectedWorkerExecutableHash !== activeWorkerIdentity.executableHash
  ) {
    reasons.push('visual_worker_executable_hash_mismatch');
    gaps.push('visual_worker_executable_hash_mismatch');
  }

  if (options?.diagnosticDelayMs) {
    await sleep(Math.min(10000, Math.max(0, Number(options.diagnosticDelayMs) || 0)));
  }

  const before = await resolveImageInput(request.before, 'before', { allowedRoots, reasons, gaps });
  const after = await resolveImageInput(request.after, 'after', { allowedRoots, reasons, gaps });
  if (!before.bytes) reasons.push('visual_worker_before_image_missing');
  if (!after.bytes) reasons.push('visual_worker_after_image_missing');

  if (request.requireRoiEvidence === true && !firstObject(
    request.roi,
    request.oracleRegion,
    request.oracle_region,
    request.regionOfInterest,
    request.region_of_interest,
  )) {
    reasons.push('visual_worker_roi_required_missing');
  }

  if (reasons.length) {
    return finalizeResult({
      accepted: false,
      startedAt,
      reasons,
      gaps,
      inputArtifacts: { before: before.summary, after: after.summary },
    });
  }

  let decodedBefore;
  let decodedAfter;
  try {
    decodedBefore = await imagePipeline(before.bytes, request).raw().toBuffer({ resolveWithObject: true });
    decodedAfter = await imagePipeline(after.bytes, request)
      .resize(decodedBefore.info.width, decodedBefore.info.height, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
  } catch (error) {
    return finalizeResult({
      accepted: false,
      startedAt,
      reasons: ['visual_worker_image_decode_failed'],
      gaps: ['visual_worker_image_decode_failed'],
      details: { message: error?.message ?? String(error) },
      inputArtifacts: { before: before.summary, after: after.summary },
    });
  }

  const dimensions = {
    width: decodedBefore.info.width,
    height: decodedBefore.info.height,
    channels: decodedBefore.info.channels,
  };
  const roi = normalizeRoi(firstObject(
    request.roi,
    request.oracleRegion,
    request.oracle_region,
    request.regionOfInterest,
    request.region_of_interest,
  ), dimensions, reasons);
  if (reasons.length) {
    return finalizeResult({
      accepted: false,
      startedAt,
      reasons,
      gaps,
      dimensions,
      inputArtifacts: { before: before.summary, after: after.summary },
    });
  }

  const tileSize = normalizeTileSize(request.tileSize ?? request.tile_size, dimensions);
  const tileEvidence = request.tileHashing === false || request.tile_hashing === false
    ? null
    : computeTileHashes(decodedBefore, decodedAfter, tileSize);

  let roiEvidence = null;
  let roiTileConsistency = null;
  let deepDiffSkipped = false;
  let skipReason = null;
  if (roi) {
    const beforeHash = hashRawRegion(decodedBefore.data, decodedBefore.info, roi);
    const afterHash = hashRawRegion(decodedAfter.data, decodedBefore.info, roi);
    roiTileConsistency = tileEvidence ? summarizeRoiTileConsistency(tileEvidence, roi) : null;
    roiEvidence = {
      accepted: true,
      roi,
      beforeHash,
      before_hash: beforeHash,
      afterHash,
      after_hash: afterHash,
      changed: beforeHash !== afterHash,
      tileConsistency: roiTileConsistency,
      tile_consistency: roiTileConsistency,
    };
    if (request.allowRoiEarlyExit === true && beforeHash === afterHash) {
      if (!tileEvidence) {
        skipReason = 'roi_hash_unchanged_but_tile_evidence_missing';
        roiEvidence.earlyExitAccepted = false;
        roiEvidence.early_exit_accepted = false;
        roiEvidence.earlyExitBlockedReason = skipReason;
        roiEvidence.early_exit_blocked_reason = skipReason;
      } else if (roiTileConsistency && roiTileConsistency.changedTileCount > 0) {
        skipReason = roiTileConsistency.changedTilesOutsideRoiCount > 0
          ? 'roi_hash_unchanged_but_tiles_changed_outside_roi'
          : 'roi_hash_unchanged_but_tile_evidence_changed';
        roiEvidence.earlyExitAccepted = false;
        roiEvidence.early_exit_accepted = false;
        roiEvidence.earlyExitBlockedReason = skipReason;
        roiEvidence.early_exit_blocked_reason = skipReason;
      } else {
        deepDiffSkipped = true;
        skipReason = 'roi_hash_unchanged';
        roiEvidence.earlyExitAccepted = true;
        roiEvidence.early_exit_accepted = true;
      }
    }
  }

  let fullFrameDiff = null;
  let diffArtifact = null;
  if (!deepDiffSkipped) {
    fullFrameDiff = computeFullFrameDiff(decodedBefore, decodedAfter);
    if (request.diffPath) {
      const diffPath = await validateOutputPath(request.diffPath, allowedOutputRoots, reasons);
      if (diffPath) {
        await sharp(fullFrameDiff.diffBytes, {
          raw: {
            width: dimensions.width,
            height: dimensions.height,
            channels: 4,
          },
        }).png().toFile(diffPath);
        const diffBytes = await readFile(diffPath);
        diffArtifact = {
          path: diffPath,
          hash: sha256Bytes(diffBytes),
          byteLength: diffBytes.byteLength,
        };
      }
    }
  }

  if (reasons.length) {
    return finalizeResult({
      accepted: false,
      startedAt,
      reasons,
      gaps,
      dimensions,
      inputArtifacts: { before: before.summary, after: after.summary },
    });
  }

  const metrics = fullFrameDiff
    ? {
        changedRatio: fullFrameDiff.changedRatio,
        changed_ratio: fullFrameDiff.changedRatio,
        meanAbs: fullFrameDiff.meanAbs,
        mean_abs: fullFrameDiff.meanAbs,
        meanAbsDelta8bit: fullFrameDiff.meanAbsDelta8bit,
        mean_abs_delta_8bit: fullFrameDiff.meanAbsDelta8bit,
        changedPixels: fullFrameDiff.changedPixels,
        changed_pixels: fullFrameDiff.changedPixels,
        changedPixelsThreshold4: fullFrameDiff.changedPixelsThreshold4,
        changed_pixels_threshold_4: fullFrameDiff.changedPixelsThreshold4,
        changedPixelRatioThreshold4: fullFrameDiff.changedPixelRatioThreshold4,
        changed_pixel_ratio_threshold_4: fullFrameDiff.changedPixelRatioThreshold4,
        visiblePixelCount: fullFrameDiff.visiblePixelCount,
        visible_pixel_count: fullFrameDiff.visiblePixelCount,
        visiblePixelRatio: fullFrameDiff.visiblePixelRatio,
        visible_pixel_ratio: fullFrameDiff.visiblePixelRatio,
        meanLuma8bit: fullFrameDiff.meanLuma8bit,
        mean_luma_8bit: fullFrameDiff.meanLuma8bit,
        pixelCount: fullFrameDiff.pixelCount,
        pixel_count: fullFrameDiff.pixelCount,
      }
    : {
        changedRatio: 0,
        changed_ratio: 0,
        meanAbs: 0,
        mean_abs: 0,
        meanAbsDelta8bit: 0,
        mean_abs_delta_8bit: 0,
        changedPixels: 0,
        changed_pixels: 0,
        changedPixelsThreshold4: 0,
        changed_pixels_threshold_4: 0,
        changedPixelRatioThreshold4: 0,
        changed_pixel_ratio_threshold_4: 0,
        visiblePixelCount: 0,
        visible_pixel_count: 0,
        visiblePixelRatio: 0,
        visible_pixel_ratio: 0,
        meanLuma8bit: 0,
        mean_luma_8bit: 0,
        pixelCount: Math.max(1, dimensions.width * dimensions.height),
        pixel_count: Math.max(1, dimensions.width * dimensions.height),
      };

  const result = finalizeResult({
    accepted: true,
    startedAt,
    reasons,
    gaps,
    dimensions,
    inputArtifacts: { before: before.summary, after: after.summary },
    inputHashes: {
      beforeEncodedHash: before.encodedHash,
      before_encoded_hash: before.encodedHash,
      afterEncodedHash: after.encodedHash,
      after_encoded_hash: after.encodedHash,
      beforeRawHash: hashRawFrame(decodedBefore.data, dimensions),
      before_raw_hash: hashRawFrame(decodedBefore.data, dimensions),
      afterRawHash: hashRawFrame(decodedAfter.data, dimensions),
      after_raw_hash: hashRawFrame(decodedAfter.data, dimensions),
    },
    roiEvidence,
    roi_evidence: roiEvidence,
    roiTileConsistency,
    roi_tile_consistency: roiTileConsistency,
    tileEvidence,
    tile_evidence: tileEvidence,
    diffArtifact,
    diff_artifact: diffArtifact,
    fullFrameDiff: fullFrameDiff
      ? {
          changedRatio: metrics.changedRatio,
          changed_ratio: metrics.changedRatio,
          meanAbs: metrics.meanAbs,
          mean_abs: metrics.meanAbs,
          meanAbsDelta8bit: metrics.meanAbsDelta8bit,
          mean_abs_delta_8bit: metrics.meanAbsDelta8bit,
          changedPixels: metrics.changedPixels,
          changed_pixels: metrics.changedPixels,
          changedPixelsThreshold4: metrics.changedPixelsThreshold4,
          changed_pixels_threshold_4: metrics.changedPixelsThreshold4,
          changedPixelRatioThreshold4: metrics.changedPixelRatioThreshold4,
          changed_pixel_ratio_threshold_4: metrics.changedPixelRatioThreshold4,
          visiblePixelCount: metrics.visiblePixelCount,
          visible_pixel_count: metrics.visiblePixelCount,
          visiblePixelRatio: metrics.visiblePixelRatio,
          visible_pixel_ratio: metrics.visiblePixelRatio,
          meanLuma8bit: metrics.meanLuma8bit,
          mean_luma_8bit: metrics.meanLuma8bit,
          pixelCount: metrics.pixelCount,
          pixel_count: metrics.pixelCount,
        }
      : null,
    metrics,
    changedRatio: metrics.changedRatio,
    changed_ratio: metrics.changedRatio,
    meanAbs: metrics.meanAbs,
    mean_abs: metrics.meanAbs,
    incremental: {
      roiEvaluated: Boolean(roiEvidence),
      roi_evaluated: Boolean(roiEvidence),
      tileHashing: Boolean(tileEvidence),
      tile_hashing: Boolean(tileEvidence),
      fullFrameDiffComputed: Boolean(fullFrameDiff),
      full_frame_diff_computed: Boolean(fullFrameDiff),
      deepDiffSkipped,
      deep_diff_skipped: deepDiffSkipped,
      skipReason,
      skip_reason: skipReason,
      roiEarlyExitSafe: Boolean(roiTileConsistency && roiTileConsistency.changedTileCount === 0),
      roi_early_exit_safe: Boolean(roiTileConsistency && roiTileConsistency.changedTileCount === 0),
      roiEarlyExitBlocked: Boolean(
        skipReason
        && !deepDiffSkipped
      ),
      roi_early_exit_blocked: Boolean(
        skipReason
        && !deepDiffSkipped
      ),
    },
  });
  result.proofHash = sha256Text(stableJson({ ...result, proofHash: undefined, proof_hash: undefined }));
  result.proof_hash = result.proofHash;
  return result;
}

async function resolveImageInput(input, role, context) {
  const entry = input && typeof input === 'object' ? input : {};
  const manifest = firstObject(entry.casManifest, entry.cas_manifest, entry.locator, entry.artifactLocator, entry);
  if (manifest?.schemaVersion || manifest?.schema_version || manifest?.artifactId || manifest?.contentHash) {
    const validation = await validateArtifactCasManifest(manifest, {
      allowedRoots: context.allowedRoots,
      requireReadableBytes: true,
    });
    if (!validation.accepted) {
      context.reasons.push(`${role}_cas_manifest_rejected`);
      context.gaps.push(...validation.reasons.map((reason) => `${role}_${reason}`));
      return {
        bytes: null,
        summary: {
          role,
          transportKind: manifest?.transport?.kind ?? null,
          casValidation: validation,
        },
      };
    }
    const localPath = manifest.storage?.localPath;
    const resolvedLocalPath = validation.localPath ?? validation.local_path ?? localPath;
    const bytes = await readFile(resolvedLocalPath);
    return {
      bytes,
      encodedHash: sha256Bytes(bytes),
      summary: {
        role,
        transportKind: manifest.transport?.kind ?? null,
        artifactId: manifest.artifactId ?? null,
        contentHash: manifest.contentHash ?? null,
        manifestHash: validation.manifestHash,
        localPath: resolvedLocalPath,
        casValidation: validation,
      },
    };
  }

  const localPath = text(entry.path ?? entry.localPath ?? entry.local_path);
  if (localPath) {
    const resolved = await validateInputPath(localPath, context.allowedRoots, context.reasons, role);
    if (!resolved) return { bytes: null, summary: { role, localPath } };
    const bytes = await readFile(resolved);
    return {
      bytes,
      encodedHash: sha256Bytes(bytes),
      summary: {
        role,
        transportKind: 'direct_worker_path',
        localPath: resolved,
        contentHash: sha256Bytes(bytes),
      },
    };
  }

  const base64 = text(entry.imageData ?? entry.image_data ?? entry.bytesBase64 ?? entry.bytes_base64);
  if (base64) {
    const bytes = Buffer.from(base64, 'base64');
    return {
      bytes,
      encodedHash: sha256Bytes(bytes),
      summary: {
        role,
        transportKind: 'serialized_fallback',
        byteLength: bytes.byteLength,
        contentHash: sha256Bytes(bytes),
      },
    };
  }

  if (entry.bytes instanceof Uint8Array || Buffer.isBuffer(entry.bytes)) {
    const bytes = Buffer.from(entry.bytes);
    return {
      bytes,
      encodedHash: sha256Bytes(bytes),
      summary: {
        role,
        transportKind: 'serialized_fallback',
        byteLength: bytes.byteLength,
        contentHash: sha256Bytes(bytes),
      },
    };
  }

  return { bytes: null, summary: { role, transportKind: null } };
}

function computeFullFrameDiff(before, after) {
  const pixelCount = Math.max(1, before.info.width * before.info.height);
  const diffBytes = Buffer.alloc(pixelCount * 4);
  let changedPixels = 0;
  let changedPixelsThreshold4 = 0;
  let visiblePixelCount = 0;
  let totalLuma = 0;
  let totalAbsRgb = 0;
  let totalAbsAllChannels = 0;
  for (let i = 0, p = 0; i < before.data.length && i < after.data.length; i += before.info.channels, p += 4) {
    const dr = Math.abs((before.data[i] ?? 0) - (after.data[i] ?? 0));
    const dg = Math.abs((before.data[i + 1] ?? 0) - (after.data[i + 1] ?? 0));
    const db = Math.abs((before.data[i + 2] ?? 0) - (after.data[i + 2] ?? 0));
    const da = before.info.channels >= 4
      ? Math.abs((before.data[i + 3] ?? 0) - (after.data[i + 3] ?? 0))
      : 0;
    const delta = dr + dg + db;
    const alpha = before.info.channels >= 4 ? (after.data[i + 3] ?? 0) : 255;
    totalAbsRgb += delta / 3;
    totalAbsAllChannels += delta + da;
    if (delta > 42) changedPixels += 1;
    if (Math.max(dr, dg, db) > 4) changedPixelsThreshold4 += 1;
    if (
      alpha > 0
      && ((after.data[i] ?? 0) > 4 || (after.data[i + 1] ?? 0) > 4 || (after.data[i + 2] ?? 0) > 4)
    ) {
      visiblePixelCount += 1;
    }
    totalLuma += 0.2126 * (after.data[i] ?? 0)
      + 0.7152 * (after.data[i + 1] ?? 0)
      + 0.0722 * (after.data[i + 2] ?? 0);
    diffBytes[p] = Math.min(255, dr * 4);
    diffBytes[p + 1] = Math.min(255, dg * 4);
    diffBytes[p + 2] = Math.min(255, db * 4);
    diffBytes[p + 3] = 255;
  }
  return {
    changedRatio: changedPixels / pixelCount,
    meanAbs: totalAbsRgb / pixelCount,
    meanAbsDelta8bit: totalAbsAllChannels / (pixelCount * Math.max(1, before.info.channels)),
    changedPixels,
    changedPixelsThreshold4,
    changedPixelRatioThreshold4: changedPixelsThreshold4 / pixelCount,
    visiblePixelCount,
    visiblePixelRatio: visiblePixelCount / pixelCount,
    meanLuma8bit: totalLuma / pixelCount,
    pixelCount,
    diffBytes,
  };
}

function imagePipeline(bytes, request) {
  const pipeline = sharp(bytes);
  return (request.includeAlpha === true || request.include_alpha === true)
    ? pipeline.ensureAlpha()
    : pipeline.removeAlpha();
}

function computeTileHashes(before, after, tileSize) {
  const width = before.info.width;
  const height = before.info.height;
  const tiles = [];
  let changedTileCount = 0;
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      const tile = {
        x,
        y,
        width: Math.min(tileSize, width - x),
        height: Math.min(tileSize, height - y),
      };
      const beforeHash = hashRawRegion(before.data, before.info, tile);
      const afterHash = hashRawRegion(after.data, before.info, tile);
      const changed = beforeHash !== afterHash;
      if (changed) changedTileCount += 1;
      tiles.push({
        ...tile,
        beforeHash,
        before_hash: beforeHash,
        afterHash,
        after_hash: afterHash,
        changed,
      });
    }
  }
  return {
    accepted: true,
    tileSize,
    tile_size: tileSize,
    tileCount: tiles.length,
    tile_count: tiles.length,
    changedTileCount,
    changed_tile_count: changedTileCount,
    changedTileRatio: tiles.length ? changedTileCount / tiles.length : 0,
    changed_tile_ratio: tiles.length ? changedTileCount / tiles.length : 0,
    tiles,
  };
}

function summarizeRoiTileConsistency(tileEvidence, roi) {
  const tiles = Array.isArray(tileEvidence?.tiles) ? tileEvidence.tiles : [];
  let changedTileCount = 0;
  let changedTilesInsideRoiCount = 0;
  let changedTilesOutsideRoiCount = 0;
  for (const tile of tiles) {
    if (!tile?.changed) continue;
    changedTileCount += 1;
    if (regionContainedBy(tile, roi)) {
      changedTilesInsideRoiCount += 1;
    } else {
      changedTilesOutsideRoiCount += 1;
    }
  }
  return {
    accepted: true,
    changedTileCount,
    changed_tile_count: changedTileCount,
    changedTilesInsideRoiCount,
    changed_tiles_inside_roi_count: changedTilesInsideRoiCount,
    changedTilesOutsideRoiCount,
    changed_tiles_outside_roi_count: changedTilesOutsideRoiCount,
    roi,
  };
}

function regionContainedBy(region, container) {
  return region.x >= container.x
    && region.y >= container.y
    && region.x + region.width <= container.x + container.width
    && region.y + region.height <= container.y + container.height;
}

function hashRawFrame(data, dimensions) {
  const hash = createHash('sha256');
  hash.update(stableJson(dimensions));
  hash.update(data);
  return `sha256:${hash.digest('hex')}`;
}

function hashRawRegion(data, info, roi) {
  const hash = createHash('sha256');
  hash.update(stableJson({ roi, channels: info.channels, layout: 'rgb_raw_rows' }));
  for (let row = roi.y; row < roi.y + roi.height; row += 1) {
    const start = (row * info.width + roi.x) * info.channels;
    const end = start + (roi.width * info.channels);
    hash.update(data.subarray(start, end));
  }
  return `sha256:${hash.digest('hex')}`;
}

function normalizeRoi(raw, dimensions, reasons) {
  if (!raw) return null;
  const roi = {
    x: Math.floor(Number(raw.x ?? raw.left ?? 0)),
    y: Math.floor(Number(raw.y ?? raw.top ?? 0)),
    width: Math.floor(Number(raw.width ?? raw.w ?? 0)),
    height: Math.floor(Number(raw.height ?? raw.h ?? 0)),
  };
  if (
    !Number.isSafeInteger(roi.x)
    || !Number.isSafeInteger(roi.y)
    || !Number.isSafeInteger(roi.width)
    || !Number.isSafeInteger(roi.height)
    || roi.x < 0
    || roi.y < 0
    || roi.width <= 0
    || roi.height <= 0
    || roi.x + roi.width > dimensions.width
    || roi.y + roi.height > dimensions.height
  ) {
    reasons.push('visual_worker_roi_invalid_or_out_of_bounds');
    return null;
  }
  return roi;
}

function normalizeTileSize(value, dimensions) {
  const number = Number(value);
  const fallback = 128;
  const requested = Number.isSafeInteger(number) && number > 0 ? number : fallback;
  return Math.max(1, Math.min(requested, Math.max(dimensions.width, dimensions.height)));
}

async function validateInputPath(candidate, allowedRoots, reasons, role) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    reasons.push(`${role}_allowed_root_required_for_path`);
    return null;
  }
  const resolved = await resolveExistingPathInsideAllowedRoots(candidate, allowedRoots);
  if (!resolved.accepted) {
    reasons.push(`${role}_path_outside_allowed_roots`);
    return null;
  }
  return resolved.path;
}

async function validateOutputPath(candidate, allowedRoots, reasons) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    reasons.push('visual_worker_diff_allowed_output_root_required');
    return null;
  }
  const resolved = resolvePathLexicallyInsideAllowedRoots(candidate, allowedRoots);
  if (!resolved.accepted) {
    reasons.push('visual_worker_diff_path_outside_allowed_roots');
    return null;
  }
  await mkdir(path.dirname(resolved.path), { recursive: true });
  const parent = await resolveExistingPathInsideAllowedRoots(path.dirname(resolved.path), allowedRoots);
  if (!parent.accepted) {
    reasons.push('visual_worker_diff_parent_path_outside_allowed_roots');
    return null;
  }
  return path.join(parent.path, path.basename(resolved.path));
}

function resolvePathLexicallyInsideAllowedRoots(candidate, roots) {
  const resolved = path.resolve(String(candidate ?? ''));
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(caseNormalizedPath(resolvedRoot), caseNormalizedPath(resolved));
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return { accepted: true, path: resolved, root: resolvedRoot };
    }
  }
  return { accepted: false, path: resolved, root: null };
}

async function resolveExistingPathInsideAllowedRoots(candidate, roots) {
  const lexical = resolvePathLexicallyInsideAllowedRoots(candidate, roots);
  if (!lexical.accepted) return lexical;
  let candidateRealPath;
  try {
    candidateRealPath = await realpath(lexical.path);
  } catch {
    return { accepted: false, path: lexical.path, root: lexical.root };
  }
  for (const root of roots) {
    let rootRealPath;
    try {
      rootRealPath = await realpath(path.resolve(root));
    } catch {
      continue;
    }
    const relative = path.relative(caseNormalizedPath(rootRealPath), caseNormalizedPath(candidateRealPath));
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return { accepted: true, path: candidateRealPath, root: rootRealPath };
    }
  }
  return { accepted: false, path: candidateRealPath, root: null };
}

function finalizeResult(input) {
  const accepted = input.accepted === true;
  const result = {
    schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    eventType: 'proof_ready',
    accepted,
    acceptedAsAsyncVisualMetrics: accepted,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
    worker: {
      kind: 'node_worker_threads',
      threadId,
      thread_id: threadId,
      offMainThread: !isMainThread,
      off_main_thread: !isMainThread,
      ...(activeWorkerIdentity ?? {}),
    },
    incremental: {
      roiEvaluated: false,
      roi_evaluated: false,
      tileHashing: false,
      tile_hashing: false,
      fullFrameDiffComputed: false,
      full_frame_diff_computed: false,
      deepDiffSkipped: false,
      deep_diff_skipped: false,
      skipReason: null,
      skip_reason: null,
      ...(input.incremental ?? {}),
    },
    reasons: Array.isArray(input.reasons) ? input.reasons : [],
    gaps: Array.isArray(input.gaps) ? input.gaps : [],
    durationMs: Math.max(0, Date.now() - input.startedAt),
    duration_ms: Math.max(0, Date.now() - input.startedAt),
    ...input,
  };
  delete result.startedAt;
  if (!result.proofHash) {
    result.proofHash = sha256Text(stableJson({ ...result, proofHash: undefined, proof_hash: undefined }));
    result.proof_hash = result.proofHash;
  }
  return result;
}

function failResult(reason, details = {}) {
  return finalizeResult({
    accepted: false,
    startedAt: Date.now(),
    reasons: [reason],
    gaps: [reason],
    details,
  });
}

function postWorkerResult(result) {
  parentPort.postMessage(result);
  parentPort.close();
}

async function currentVisualWorkerIdentity() {
  if (cachedWorkerIdentity) return cachedWorkerIdentity;
  const executableIdentity = await computeVisualWorkerExecutableIdentity();
  cachedWorkerIdentity = {
    identitySchemaVersion: 'synthi.gpu_hmr.visual_worker_identity.v1',
    identity_schema_version: 'synthi.gpu_hmr.visual_worker_identity.v1',
    executorIdentity: 'node_worker_threads_visual_proof_worker',
    executor_identity: 'node_worker_threads_visual_proof_worker',
    ...executableIdentity,
    scriptUrl: import.meta.url,
    script_url: import.meta.url,
  };
  return cachedWorkerIdentity;
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object' && !Array.isArray(value)) ?? null;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function caseNormalizedPath(value) {
  return process.platform === 'win32' ? String(value).toLowerCase() : String(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
