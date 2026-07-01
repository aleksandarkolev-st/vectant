import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  artifactCasManifestEvidence,
  collectArtifactLocators,
  defaultCasRootFromEnv,
  sha256Text,
  stableJson,
  validateArtifactLocator,
  writeArtifactToCas,
} from './gpu-hmr-artifact-cas.mjs';
import {
  GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  computeAsyncVisualProof,
} from './gpu-hmr-visual-proof-worker.mjs';

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
export const GPU_HMR_VISUAL_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION =
  'synthi.gpu_hmr.visual_artifact_transport_evidence.v1';
export const GPU_HMR_ASYNC_VISUAL_PROOF_JOB_SCHEMA_VERSION =
  'synthi.gpu_hmr.async_visual_proof_job.v1';
export const GPU_HMR_ASYNC_VISUAL_PROOF_JOB_AUTHORITY =
  'async_visual_job_manifest_only_not_gpu_hmr_acceptance';
export const DEFAULT_MCP_FRAME_GATE_TIMEOUT_MS = 20 * 60 * 1000;

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

function pathTextOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstObject(...values) {
  for (const value of values) {
    if (isObject(value)) return value;
  }
  return null;
}

function bufferFromInput(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  return null;
}

function uniquePaths(...paths) {
  return [...new Set(paths.map(pathTextOrNull).filter(Boolean).map((entry) => path.resolve(entry)))];
}

function pathInsideOrSame(child, root) {
  const resolvedChild = path.resolve(child);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedChild);
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function asyncVisualProofJobManifestForHash(job = {}) {
  const workerOptions = firstObject(job.workerOptions, job.worker_options) ?? {};
  const artifactCasLocators = Array.isArray(job.artifactCasLocators)
    ? job.artifactCasLocators
    : Array.isArray(job.artifact_cas_locators)
      ? job.artifact_cas_locators
      : [];
  const visualArtifactTransportEvidence = firstObject(
    job.visualArtifactTransportEvidence,
    job.visual_artifact_transport_evidence,
  ) ?? null;
  return {
    schemaVersion: job.schemaVersion ?? job.schema_version,
    schema_version: job.schema_version ?? job.schemaVersion,
    eventType: job.eventType ?? job.event_type,
    event_type: job.event_type ?? job.eventType,
    proofPending: job.proofPending ?? job.proof_pending,
    proof_pending: job.proof_pending ?? job.proofPending,
    proofReady: job.proofReady ?? job.proof_ready,
    proof_ready: job.proof_ready ?? job.proofReady,
    accepted: job.accepted,
    acceptedAsAsyncVisualProofJob: job.acceptedAsAsyncVisualProofJob ?? job.accepted_as_async_visual_proof_job,
    accepted_as_async_visual_proof_job: job.accepted_as_async_visual_proof_job ?? job.acceptedAsAsyncVisualProofJob,
    acceptedForGpuHmr: job.acceptedForGpuHmr ?? job.accepted_for_gpu_hmr,
    accepted_for_gpu_hmr: job.accepted_for_gpu_hmr ?? job.acceptedForGpuHmr,
    gpuHmrSuccess: job.gpuHmrSuccess ?? job.gpu_hmr_success,
    gpu_hmr_success: job.gpu_hmr_success ?? job.gpuHmrSuccess,
    proofAuthority: job.proofAuthority ?? job.proof_authority,
    proof_authority: job.proof_authority ?? job.proofAuthority,
    createdAtMs: job.createdAtMs ?? job.created_at_ms,
    created_at_ms: job.created_at_ms ?? job.createdAtMs,
    sessionNamespace: job.sessionNamespace ?? job.session_namespace,
    session_namespace: job.session_namespace ?? job.sessionNamespace,
    producer: firstObject(job.producer) ?? null,
    producerSubsystem: job.producerSubsystem ?? job.producer_subsystem,
    producer_subsystem: job.producer_subsystem ?? job.producerSubsystem,
    artifactDir: job.artifactDir ?? job.artifact_dir,
    artifact_dir: job.artifact_dir ?? job.artifactDir,
    casRoot: job.casRoot ?? job.cas_root,
    cas_root: job.cas_root ?? job.casRoot,
    request: firstObject(job.request) ?? null,
    workerOptions,
    worker_options: workerOptions,
    artifactCasLocators,
    artifact_cas_locators: artifactCasLocators,
    visualArtifactTransportEvidence,
    visual_artifact_transport_evidence: visualArtifactTransportEvidence,
  };
}

function assertAsyncVisualProofJobIntegrity(job = {}) {
  const declaredHash = textOrNull(job.jobHash ?? job.job_hash);
  const declaredManifestHash = textOrNull(job.jobManifestHash ?? job.job_manifest_hash);
  if (!declaredHash || !declaredManifestHash) {
    throw new Error('async_visual_proof_job_hash_missing');
  }
  const recomputed = sha256Text(stableJson(asyncVisualProofJobManifestForHash(job)));
  if (declaredHash !== recomputed || declaredManifestHash !== recomputed) {
    throw new Error('async_visual_proof_job_hash_mismatch');
  }
  const locator = firstObject(job.jobManifestLocator, job.job_manifest_locator);
  const locatorHash = textOrNull(locator?.contentHash ?? locator?.content_hash);
  if (locatorHash && locatorHash !== recomputed) {
    throw new Error('async_visual_proof_job_manifest_locator_hash_mismatch');
  }
  return recomputed;
}

function trustedCasRootFromCompletionOptions(options = {}, allowedRoots = []) {
  const candidate = path.resolve(
    pathTextOrNull(options.casRoot ?? options.cas_root ?? options.artifactRoot ?? options.artifact_root)
    ?? allowedRoots[0],
  );
  if (!allowedRoots.some((root) => pathInsideOrSame(candidate, root))) {
    throw new Error('async_visual_proof_job_completion_cas_root_untrusted');
  }
  return candidate;
}

function visualWorkerMetric(metrics, ...keys) {
  for (const key of keys) {
    const value = finiteNumberOrNull(metrics?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeFrameHashes(...values) {
  return compactStringList(values.flatMap((value) => (
    Array.isArray(value) ? value : []
  )));
}

function normalizeConvergenceSamples(value) {
  return (Array.isArray(value) ? value : [])
    .filter((sample) => isObject(sample))
    .map((sample) => {
      const frameHash = textOrNull(
        sample.frame_hash
        ?? sample.frameHash
        ?? sample.image_hash
        ?? sample.imageHash
        ?? sample.source_frame_hash
        ?? sample.sourceFrameHash,
      );
      const artifactHash = textOrNull(sample.artifact_hash ?? sample.artifactHash);
      return {
        frame: finiteNumberOrNull(sample.frame ?? sample.frame_index ?? sample.frameIndex),
        epoch: textOrNull(sample.epoch ?? sample.epoch_id ?? sample.epochId),
        metric_value: finiteNumberOrNull(
          sample.metric_value ?? sample.metricValue ?? sample.value,
        ),
        frame_hash: frameHash,
        artifact_hash: artifactHash,
        hash_source: frameHash ? 'frame_hash' : artifactHash ? 'artifact_hash' : null,
        after_epoch_dispatch: boolOrNull(
          sample.after_epoch_dispatch ?? sample.afterEpochDispatch,
        ),
      };
    });
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
  const sampleFrameHashes = compactStringList(samples.map((sample) => sample.frame_hash));
  const artifactHashes = compactStringList([
    ...(Array.isArray(window.artifact_hashes) ? window.artifact_hashes : []),
    ...(Array.isArray(window.artifactHashes) ? window.artifactHashes : []),
    window.artifact_hash,
    window.artifactHash,
    ...samples.map((sample) => sample.artifact_hash),
  ]);
  return {
    frame_start: frameStart,
    frame_end: frameEnd,
    metric: metricValue ? { value: metricValue } : null,
    min_frames:
      finiteNumberOrNull(window.min_frames ?? window.minFrames)
      ?? (frameStart !== null && frameEnd !== null ? Math.max(0, frameEnd - frameStart + 1) : null),
    sample_count: sampleCount,
    samples,
    sample_frame_hashes: sampleFrameHashes,
    frame_hashes: frameHashes,
    pre_epoch_frame_hashes: preEpochFrameHashes,
    post_epoch_frame_hashes: postEpochFrameHashes,
    artifact_hashes: artifactHashes,
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
  const hasSampleEvidence = window.sample_frame_hashes.length >= requiredSamples
    || window.frame_hashes.length >= requiredSamples
    || window.post_epoch_frame_hashes.length >= requiredSamples;
  const hasMetricEvidence =
    window.metric_value !== null
    || window.metric_delta !== null
    || window.samples.some((sample) => sample.metric_value !== null);
  return hasSampleEvidence
    && hasMetricEvidence
    && window.artifact_hashes.length === 0
    && window.convergence_proven === true
    && window.evidence_refs.length > 0;
}

function screenshotDimension(shot, key) {
  const meta = isObject(shot?.screenshot_metadata ?? shot?.screenshotMetadata)
    ? (shot.screenshot_metadata ?? shot.screenshotMetadata)
    : {};
  return finiteNumberOrNull(shot?.[key] ?? meta[key]);
}

function screenshotFrameSeq(shot) {
  const meta = isObject(shot?.screenshot_metadata ?? shot?.screenshotMetadata)
    ? (shot.screenshot_metadata ?? shot.screenshotMetadata)
    : {};
  return finiteNumberOrNull(
    shot?.seq
    ?? shot?.frame_seq
    ?? shot?.frameSeq
    ?? meta.seq
    ?? meta.frame_seq
    ?? meta.frameSeq,
  );
}

function screenshotTimestampMs(shot) {
  const meta = isObject(shot?.screenshot_metadata ?? shot?.screenshotMetadata)
    ? (shot.screenshot_metadata ?? shot.screenshotMetadata)
    : {};
  return finiteNumberOrNull(
    shot?.ts
    ?? shot?.timestamp_ms
    ?? shot?.timestampMs
    ?? meta.ts
    ?? meta.timestamp_ms
    ?? meta.timestampMs,
  );
}

function screenshotCaptureManifest(shot) {
  const meta = isObject(shot?.screenshot_metadata ?? shot?.screenshotMetadata)
    ? (shot.screenshot_metadata ?? shot.screenshotMetadata)
    : {};
  return isObject(shot?.capture_manifest ?? shot?.captureManifest)
    ? (shot.capture_manifest ?? shot.captureManifest)
    : isObject(meta.capture_manifest ?? meta.captureManifest)
      ? (meta.capture_manifest ?? meta.captureManifest)
      : null;
}

function screenshotImageHash(shot) {
  const meta = isObject(shot?.screenshot_metadata ?? shot?.screenshotMetadata)
    ? (shot.screenshot_metadata ?? shot.screenshotMetadata)
    : {};
  return textOrNull(
    shot?.image_sha256
    ?? shot?.imageSha256
    ?? shot?.sha256
    ?? meta.image_sha256
    ?? meta.imageSha256
    ?? meta.sha256,
  );
}

function captureManifestImageHash(manifest) {
  return textOrNull(
    manifest?.image_sha256
    ?? manifest?.imageSha256
    ?? manifest?.image_hash
    ?? manifest?.imageHash,
  );
}

function captureManifestFrameHash(manifest) {
  return textOrNull(
    manifest?.source_frame_hash
    ?? manifest?.sourceFrameHash
    ?? manifest?.broker_frame_hash
    ?? manifest?.brokerFrameHash,
  );
}

function captureManifestVerified(shot, gate = null) {
  const manifest = screenshotCaptureManifest(shot);
  if (!manifest) return false;
  const imageHash = screenshotImageHash(shot);
  const manifestImageHash = captureManifestImageHash(manifest);
  if (!manifestImageHash) return false;
  if (imageHash && imageHash !== manifestImageHash) return false;
  if (!captureManifestFrameHash(manifest)) return false;
  if (!textOrNull(manifest.session_id ?? manifest.sessionId)) return false;
  if (!textOrNull(manifest.capture_event_id ?? manifest.captureEventId)) return false;
  if (finiteNumberOrNull(manifest.frame_event_id ?? manifest.frameEventId) === null) return false;
  if (gate) {
    const gateToken = textOrNull(gate.gate_token ?? gate.gateToken);
    if (!gateToken) return false;
    if (manifest.gate_token_verified !== true && manifest.gateTokenVerified !== true) return false;
    if (textOrNull(manifest.gate_token ?? manifest.gateToken) !== gateToken) return false;
    const gateSession = textOrNull(gate.session_id ?? gate.sessionId);
    const manifestSession = textOrNull(manifest.session_id ?? manifest.sessionId);
    if (gateSession && gateSession !== manifestSession) return false;
  }
  return true;
}

function mcpFrameGateObject(waitOrGate) {
  return isObject(waitOrGate?.frame_gate ?? waitOrGate?.frameGate)
    ? (waitOrGate.frame_gate ?? waitOrGate.frameGate)
    : waitOrGate;
}

export function mcpFrameGateSatisfied(waitOrGate) {
  const validation = isObject(waitOrGate?.gpu_proof_validation ?? waitOrGate?.gpuProofValidation)
    ? (waitOrGate.gpu_proof_validation ?? waitOrGate.gpuProofValidation)
    : null;
  if (validation && validation.satisfied !== true) return false;
  const gate = mcpFrameGateObject(waitOrGate);
  return isObject(gate) && gate.status === 'satisfied';
}

export function mcpFrameGateForScreenshot(waitOrGate) {
  if (!mcpFrameGateSatisfied(waitOrGate)) return null;
  const gate = mcpFrameGateObject(waitOrGate);
  const frameSeq = finiteNumberOrNull(gate.frame_seq ?? gate.frameSeq);
  const tsMs = finiteNumberOrNull(gate.ts_ms ?? gate.tsMs ?? gate.ts);
  const gateToken = textOrNull(gate.gate_token ?? gate.gateToken);
  if (frameSeq === null && tsMs === null) return null;
  if (!gateToken) return null;
  const sessionId = textOrNull(gate.session_id ?? gate.sessionId);
  return {
    status: 'satisfied',
    ...(frameSeq !== null ? { frame_seq: frameSeq } : {}),
    ...(tsMs !== null ? { ts_ms: tsMs } : {}),
    gate_token: gateToken,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

export function mcpScreenshotArgsForFrameGate(waitOrGate, options = {}) {
  const opts = isObject(options) ? options : {};
  const args = {
    ...(isObject(opts.baseArgs) ? opts.baseArgs : {}),
  };
  const freshnessMaxMs = finiteNumberOrNull(
    opts.freshness_max_ms ?? opts.freshnessMaxMs,
  );
  if (freshnessMaxMs !== null) args.freshness_max_ms = freshnessMaxMs;
  const gate = mcpFrameGateForScreenshot(waitOrGate);
  if (!gate) return args;
  args.after_frame_gate = gate;
  args.frame_gate_timeout_ms =
    finiteNumberOrNull(opts.frame_gate_timeout_ms ?? opts.frameGateTimeoutMs)
    ?? DEFAULT_MCP_FRAME_GATE_TIMEOUT_MS;
  return args;
}

export function mcpScreenshotMetadataFromToolResult(result) {
  if (!isObject(result)) return null;
  if (
    result.seq !== undefined
    || result.ts !== undefined
    || result.frame_seq !== undefined
    || result.frameSeq !== undefined
    || result.w !== undefined
    || result.h !== undefined
    || result.width !== undefined
    || result.height !== undefined
    || result.capture_manifest !== undefined
    || result.captureManifest !== undefined
  ) {
    return result;
  }
  return isObject(result.json)
    ? result.json
    : isObject(result.meta)
      ? result.meta
      : isObject(result.metadata)
        ? result.metadata
        : isObject(result.structuredContent)
          ? result.structuredContent
          : null;
}

export function mcpFrameAtOrAfterFrameGate(waitOrGate, afterScreenshot) {
  if (!mcpFrameGateSatisfied(waitOrGate)) return false;
  const gate = mcpFrameGateObject(waitOrGate);
  const gateSeq = finiteNumberOrNull(gate.frame_seq ?? gate.frameSeq);
  const gateTs = finiteNumberOrNull(gate.ts_ms ?? gate.tsMs ?? gate.ts);
  if (gateSeq === null && gateTs === null) return false;
  const afterSeq = screenshotFrameSeq(afterScreenshot);
  const afterTs = screenshotTimestampMs(afterScreenshot);
  const seqOk = gateSeq === null || (afterSeq !== null && afterSeq >= gateSeq);
  const tsOk = gateTs === null || (afterTs !== null && afterTs >= gateTs);
  return seqOk && tsOk;
}

export function mcpFrameGateSatisfiedByScreenshot(waitOrGate, afterScreenshot) {
  if (!mcpFrameGateSatisfied(waitOrGate)) return false;
  const gate = mcpFrameGateObject(waitOrGate);
  if (!captureManifestVerified(afterScreenshot, gate)) return false;
  return mcpFrameAtOrAfterFrameGate(waitOrGate, afterScreenshot);
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
  const frameBoundary = mcpFrameGateSatisfiedByScreenshot(evidence.wait ?? evidence, after);
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
  const nonVisualArtifactHashes = compactStringList([
    mode.artifact_hash,
    mode.artifactHash,
    mode.artifact_hash_after,
    mode.artifactHashAfter,
    mode.changed_artifact_hash,
    mode.changedArtifactHash,
    mode.gpu_artifact_hash,
    mode.gpuArtifactHash,
  ]);
  return {
    schema_version:
      textOrNull(mode.schema_version ?? mode.schemaVersion)
      ?? GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
    fixed_seed: boolOrNull(mode.fixed_seed ?? mode.fixedSeed),
    seed_policy_fixed: boolOrNull(mode.seed_policy_fixed ?? mode.seedPolicyFixed),
    seed_policy_hash: textOrNull(mode.seed_policy_hash ?? mode.seedPolicyHash),
    camera_state_hash: textOrNull(mode.camera_state_hash ?? mode.cameraStateHash),
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
    non_visual_artifact_hashes: nonVisualArtifactHashes,
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
  if (!seedPolicyFixed(mode)) {
    addGate(
      failedGates,
      convergenceAccepted
        ? 'convergence_window_seed_policy_unproven'
        : 'seed_policy_unproven',
    );
  }
  if (mode.convergence_window.frame_start !== null || mode.convergence_window.frame_end !== null) {
    const window = mode.convergence_window;
    const requiredSamples = Math.max(2, finiteNumberOrNull(window.min_frames) ?? 2);
    const observedSamples = finiteNumberOrNull(window.sample_count) ?? 0;
    const frameEvidenceHashes = compactStringList([
      ...window.sample_frame_hashes,
      ...window.frame_hashes,
      ...window.pre_epoch_frame_hashes,
      ...window.post_epoch_frame_hashes,
    ]);
    if (window.metric?.value && !CONVERGENCE_METRICS.has(window.metric.value)) {
      addGate(failedGates, 'convergence_window_metric_unsupported', {
        metric: window.metric.value,
      });
    }
    if (
      window.sample_frame_hashes.length < requiredSamples
      && window.frame_hashes.length < requiredSamples
      && window.post_epoch_frame_hashes.length < requiredSamples
    ) {
      addGate(failedGates, 'convergence_window_sample_evidence_missing', {
        requiredSamples,
        observedSamples,
      });
    }
    if (window.artifact_hashes.length > 0) {
      addGate(failedGates, 'convergence_window_artifact_hash_not_frame_evidence', {
        artifactHashCount: window.artifact_hashes.length,
      });
    }
    const leakedArtifactHashes = mode.non_visual_artifact_hashes
      .filter((hash) => frameEvidenceHashes.includes(hash));
    if (leakedArtifactHashes.length > 0) {
      addGate(failedGates, 'convergence_window_frame_hash_matches_gpu_artifact_hash', {
        hashes: leakedArtifactHashes.slice(0, 3),
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
  const manifest = screenshotCaptureManifest(shot);
  const captureBackend = textOrNull(
    shot?.capture_backend
    ?? shot?.captureBackend
    ?? manifest?.capture_backend
    ?? manifest?.captureBackend,
  );
  const manifestRequired = captureBackend === 'mcp_screenshot' || manifest !== null;
  const manifestAccepted = !manifestRequired || captureManifestVerified(shot);
  return Boolean(
    shot
      && Number(shot.width) >= MIN_VISUAL_WIDTH
      && Number(shot.height) >= MIN_VISUAL_HEIGHT
      && Number(shot.visible_pixels ?? shot.visiblePixels) > MIN_VISIBLE_PIXELS
      && quality === 'gpu-hmr-visual-varied-frame'
      && typeof (shot.path ?? shot.filePath ?? shot.file_path) === 'string'
      && String(shot.path ?? shot.filePath ?? shot.file_path).trim()
      && manifestAccepted
  );
}

export function visualEvidenceIsSupplementalOnly(artifact) {
  return artifact?.visualEvidenceSupplementalOnly === true
    || artifact?.visual_evidence_supplemental_only === true;
}

export function visualEvidenceAcceptedAsImage(artifact) {
  return artifact?.acceptedAsVisualEvidence === true
    || artifact?.accepted_as_visual_evidence === true;
}

export function visualEvidenceAcceptedAsRuntimeProof(artifact) {
  return visualEvidenceAcceptedAsImage(artifact)
    && !visualEvidenceIsSupplementalOnly(artifact);
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
  const artifactCasLocators = collectVisualArtifactCasLocators(extra);
  if (artifactCasLocators.length > 0) {
    row.artifact_cas_locators = artifactCasLocators;
    row.artifact_transport_authority = 'transport_integrity_only_not_visual_proof';
  }
  return row;
}

export function collectVisualArtifactCasLocators(input = {}) {
  const source = visualArtifactCasLocatorSource(input);
  return collectArtifactLocators(source).filter(visualCasLocatorLooksLikeImageEvidence);
}

function visualArtifactCasLocatorSource(input = {}) {
  return isObject(input)
    ? (
      input.artifact_cas_locators
      ?? input.artifactCasLocators
      ?? input.artifact_locator
      ?? input.artifactLocator
      ?? input.transport_manifest
      ?? input.transportManifest
      ?? input
    )
    : input;
}

function collectNonVisualArtifactCasLocators(input = {}) {
  return collectArtifactLocators(visualArtifactCasLocatorSource(input))
    .filter((locator) => !visualCasLocatorLooksLikeImageEvidence(locator));
}

function visualCasLocatorLooksLikeImageEvidence(locator = {}) {
  const role = (textOrNull(locator.role ?? locator.artifactRole ?? locator.artifact_role) ?? '')
    .toLowerCase();
  const kind = (textOrNull(locator.artifactKind ?? locator.artifact_kind) ?? '').toLowerCase();
  const mediaType = (textOrNull(locator.mediaType ?? locator.media_type) ?? '').toLowerCase();
  const imageRoles = new Set([
    'before',
    'after',
    'diff',
    'before_frame',
    'after_frame',
    'diff_frame',
    'baseline_frame',
    'changed_frame',
    'difference_frame',
  ]);
  return mediaType.startsWith('image/')
    || imageRoles.has(role)
    || kind.includes('visual')
    || kind.includes('frame')
    || kind.includes('screenshot')
    || kind.includes('render');
}

export async function visualArtifactTransportEvidence(input = {}, options = {}) {
  const locators = collectVisualArtifactCasLocators(input);
  const nonVisualLocators = collectNonVisualArtifactCasLocators(input);
  const entries = [];
  const reasons = [];
  const gaps = [];

  if (nonVisualLocators.length > 0) {
    reasons.push('non_visual_artifact_transport_locator_rejected');
    gaps.push('visual_artifact_transport_requires_image_locator');
  }

  for (const locator of locators) {
    const validation = await validateArtifactLocator(locator, {
      artifactRoot: options.artifactRoot,
      allowedRoots: options.allowedRoots,
      requireReadableBytes: options.requireReadableBytes === true,
    });
    const evidence = artifactCasManifestEvidence(locator, validation);
    entries.push(evidence);
    reasons.push(...validation.reasons);
    gaps.push(...validation.gaps);
  }

  if (locators.length === 0) {
    reasons.push('visual_artifact_transport_locator_missing');
  }

  return {
    schemaVersion: GPU_HMR_VISUAL_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
    accepted: locators.length > 0 && entries.every((entry) => entry.accepted === true),
    acceptedAsTransportEvidence: locators.length > 0 && entries.every((entry) =>
      entry.acceptedAsTransportEvidence === true
    ),
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: 'transport_integrity_only_not_visual_or_ledger_proof',
    locatorCount: locators.length,
    rejectedNonVisualLocatorCount: nonVisualLocators.length,
    rejected_non_visual_locator_count: nonVisualLocators.length,
    entries,
    reasons: [...new Set(reasons)],
    gaps: [...new Set(gaps)],
  };
}

function pendingAsyncVisualProof(jobHash) {
  return {
    schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    schema_version: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    eventType: 'proof_pending',
    event_type: 'proof_pending',
    accepted: false,
    acceptedAsAsyncVisualMetrics: false,
    accepted_as_async_visual_metrics: false,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
    proof_authority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
    proofJobHash: jobHash,
    proof_job_hash: jobHash,
    reasons: ['async_visual_proof_job_pending'],
    gaps: ['async_visual_proof_ready_event_missing'],
  };
}

export async function createAsyncVisualProofJob(input = {}, options = {}) {
  const beforePath = pathTextOrNull(
    input.beforePath
    ?? input.before_path
    ?? input.beforeImage
    ?? input.before_image,
  );
  const afterPath = pathTextOrNull(
    input.afterPath
    ?? input.after_path
    ?? input.afterImage
    ?? input.after_image,
  );
  const diffPath = pathTextOrNull(
    input.diffPath
    ?? input.diff_path
    ?? input.diffImage
    ?? input.diff_image,
  );
  const artifactDir = path.resolve(
    pathTextOrNull(input.artifactDir ?? input.artifact_dir)
    ?? (diffPath ? path.dirname(diffPath) : null)
    ?? (beforePath ? path.dirname(beforePath) : null)
    ?? process.cwd(),
  );
  const casRoot = path.resolve(
    pathTextOrNull(input.casRoot ?? input.cas_root ?? input.artifactRoot ?? input.artifact_root)
    ?? defaultCasRootFromEnv()
    ?? path.join(artifactDir, 'cas'),
  );
  await mkdir(casRoot, { recursive: true });

  const beforeBytes = bufferFromInput(input.beforeBytes ?? input.before_bytes)
    ?? (beforePath ? await readFile(beforePath) : null);
  const afterBytes = bufferFromInput(input.afterBytes ?? input.after_bytes)
    ?? (afterPath ? await readFile(afterPath) : null);
  if (!beforeBytes || !afterBytes) {
    throw new Error('async_visual_proof_bundle_requires_before_after_bytes_or_paths');
  }

  const sessionNamespace = textOrNull(
    input.sessionNamespace
    ?? input.session_namespace
    ?? input.namespace
    ?? input.slug,
  ) ?? 'visual-proof';
  const producer = isObject(input.producer)
    ? input.producer
    : {
        name: textOrNull(input.producer) ?? 'gpu_hmr_visual_proof_bundle',
        kind: 'visual_proof_worker',
      };
  const producerSubsystem = textOrNull(
    input.producerSubsystem
    ?? input.producer_subsystem,
  ) ?? 'visual_proof';

  const beforeLocator = await writeArtifactToCas(beforeBytes, {
    artifactRoot: casRoot,
    mediaType: input.mediaType ?? input.media_type ?? 'image/png',
    artifactKind: input.artifactKind ?? input.artifact_kind ?? 'visual_frame',
    role: 'before_frame',
    sessionNamespace,
    producer,
    producerSubsystem,
  });
  const afterLocator = await writeArtifactToCas(afterBytes, {
    artifactRoot: casRoot,
    mediaType: input.mediaType ?? input.media_type ?? 'image/png',
    artifactKind: input.artifactKind ?? input.artifact_kind ?? 'visual_frame',
    role: 'after_frame',
    sessionNamespace,
    producer,
    producerSubsystem,
  });

  const visualProof = isObject(input.visualProof ?? input.visual_proof)
    ? (input.visualProof ?? input.visual_proof)
    : {};
  const roi = firstObject(
    input.roi,
    input.oracleRegion,
    input.oracle_region,
    input.regionOfInterest,
    input.region_of_interest,
    visualProof.roi,
    visualProof.oracleRegion,
    visualProof.oracle_region,
    visualProof.regionOfInterest,
    visualProof.region_of_interest,
  );
  const workerAllowedRoots = uniquePaths(
    casRoot,
    ...(Array.isArray(options.allowedRoots) ? options.allowedRoots : []),
  );
  const workerAllowedOutputRoots = uniquePaths(
    artifactDir,
    diffPath ? path.dirname(diffPath) : null,
    ...(Array.isArray(options.allowedOutputRoots) ? options.allowedOutputRoots : []),
  );
  const request = {
    before: { casManifest: beforeLocator },
    after: { casManifest: afterLocator },
    ...(diffPath ? { diffPath } : {}),
    ...(roi ? { roi } : {}),
    allowRoiEarlyExit: input.allowRoiEarlyExit === true
      || input.allow_roi_early_exit === true
      || visualProof.allowRoiEarlyExit === true
      || visualProof.allow_roi_early_exit === true,
    tileSize: input.tileSize ?? input.tile_size ?? visualProof.tileSize ?? visualProof.tile_size ?? 128,
    tileHashing: input.tileHashing ?? input.tile_hashing ?? visualProof.tileHashing ?? visualProof.tile_hashing,
  };
  const workerOptions = {
    allowedRoots: workerAllowedRoots,
    allowedOutputRoots: workerAllowedOutputRoots,
    timeoutMs: finiteNumberOrNull(
      options.timeoutMs
      ?? input.timeoutMs
      ?? input.timeout_ms
      ?? process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_TIMEOUT_MS,
    ) ?? 30000,
  };
  const artifactCasLocators = [beforeLocator, afterLocator];
  const transportEvidence = await visualArtifactTransportEvidence({
    artifactCasLocators,
  }, {
    artifactRoot: casRoot,
    allowedRoots: [casRoot],
    requireReadableBytes: true,
  });
  const createdAtMs = Date.now();
  const jobManifest = {
    schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_JOB_SCHEMA_VERSION,
    schema_version: GPU_HMR_ASYNC_VISUAL_PROOF_JOB_SCHEMA_VERSION,
    eventType: 'proof_pending',
    event_type: 'proof_pending',
    proofPending: true,
    proof_pending: true,
    proofReady: false,
    proof_ready: false,
    accepted: false,
    acceptedAsAsyncVisualProofJob: true,
    accepted_as_async_visual_proof_job: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_JOB_AUTHORITY,
    proof_authority: GPU_HMR_ASYNC_VISUAL_PROOF_JOB_AUTHORITY,
    createdAtMs,
    created_at_ms: createdAtMs,
    sessionNamespace,
    session_namespace: sessionNamespace,
    producer,
    producerSubsystem,
    producer_subsystem: producerSubsystem,
    artifactDir,
    artifact_dir: artifactDir,
    casRoot,
    cas_root: casRoot,
    request,
    workerOptions,
    worker_options: workerOptions,
    artifactCasLocators,
    artifact_cas_locators: artifactCasLocators,
    visualArtifactTransportEvidence: transportEvidence,
    visual_artifact_transport_evidence: transportEvidence,
  };
  const jobBytes = Buffer.from(stableJson(jobManifest), 'utf8');
  const jobHash = sha256Text(stableJson(jobManifest));
  const jobManifestLocator = await writeArtifactToCas(jobBytes, {
    artifactRoot: casRoot,
    mediaType: 'application/json',
    artifactKind: 'async_visual_proof_job',
    role: 'async_visual_proof_job',
    sessionNamespace,
    producer,
    producerSubsystem,
  });
  const asyncVisualProof = pendingAsyncVisualProof(jobHash);
  return {
    ...jobManifest,
    jobId: `async-visual-proof-job:${jobHash}`,
    job_id: `async-visual-proof-job:${jobHash}`,
    jobHash,
    job_hash: jobHash,
    jobManifestHash: jobHash,
    job_manifest_hash: jobHash,
    jobManifestLocator,
    job_manifest_locator: jobManifestLocator,
    asyncVisualProof,
    async_visual_proof: asyncVisualProof,
  };
}

export async function completeAsyncVisualProofJob(jobInput = {}, options = {}) {
  const job = firstObject(
    jobInput.asyncVisualProofJob,
    jobInput.async_visual_proof_job,
    jobInput,
  ) ?? {};
  assertAsyncVisualProofJobIntegrity(job);
  const request = firstObject(job.request);
  if (!request) {
    throw new Error('async_visual_proof_job_request_missing');
  }
  const diffPath = pathTextOrNull(request.diffPath ?? request.diff_path);
  const allowedRoots = Array.isArray(options.allowedRoots)
    ? uniquePaths(...options.allowedRoots)
    : [];
  if (allowedRoots.length === 0) {
    throw new Error('async_visual_proof_job_completion_requires_trusted_allowed_roots');
  }
  const allowedOutputRoots = Array.isArray(options.allowedOutputRoots)
    ? uniquePaths(...options.allowedOutputRoots)
    : [];
  if (diffPath && allowedOutputRoots.length === 0) {
    throw new Error('async_visual_proof_job_completion_requires_trusted_output_roots');
  }
  const asyncVisualProof = await computeAsyncVisualProof(request, {
    allowedRoots,
    allowedOutputRoots,
    timeoutMs: finiteNumberOrNull(
      options.timeoutMs
      ?? options.timeout_ms
    ) ?? 30000,
  });

  const casRoot = trustedCasRootFromCompletionOptions(options, allowedRoots);
  const artifactDir = path.resolve(
    pathTextOrNull(options.artifactDir ?? options.artifact_dir)
    ?? (diffPath ? path.dirname(diffPath) : null)
    ?? allowedOutputRoots[0]
    ?? process.cwd(),
  );
  const producer = isObject(job.producer)
    ? job.producer
    : {
        name: textOrNull(job.producer) ?? 'gpu_hmr_visual_proof_bundle',
        kind: 'visual_proof_worker',
      };
  const producerSubsystem = textOrNull(job.producerSubsystem ?? job.producer_subsystem) ?? 'visual_proof';
  const sessionNamespace = textOrNull(job.sessionNamespace ?? job.session_namespace) ?? 'visual-proof';
  const artifactCasLocators = Array.isArray(job.artifactCasLocators)
    ? [...job.artifactCasLocators]
    : Array.isArray(job.artifact_cas_locators)
      ? [...job.artifact_cas_locators]
      : [];
  const beforeLocator = artifactCasLocators.find((locator) =>
    String(locator?.role ?? '').includes('before')
  ) ?? request.before?.casManifest ?? request.before?.cas_manifest ?? null;
  const afterLocator = artifactCasLocators.find((locator) =>
    String(locator?.role ?? '').includes('after')
  ) ?? request.after?.casManifest ?? request.after?.cas_manifest ?? null;

  let diffLocator = null;
  if (diffPath && asyncVisualProof.accepted === true) {
    diffLocator = await writeArtifactToCas(await readFile(diffPath), {
      artifactRoot: casRoot,
      mediaType: 'image/png',
      artifactKind: 'visual_frame',
      role: 'diff_frame',
      sessionNamespace,
      producer,
      producerSubsystem,
    });
    artifactCasLocators.push(diffLocator);
  }

  const metricsSource = isObject(asyncVisualProof.metrics) ? asyncVisualProof.metrics : {};
  const meanAbsDelta8bit = visualWorkerMetric(
    metricsSource,
    'meanAbsDelta8bit',
    'mean_abs_delta_8bit',
    'meanAbs',
    'mean_abs',
  ) ?? 0;
  const changedPixelRatio = visualWorkerMetric(
    metricsSource,
    'changedRatio',
    'changed_ratio',
    'changedPixelRatio',
    'changed_pixel_ratio',
  ) ?? 0;
  const metrics = {
    width: visualWorkerMetric(asyncVisualProof.dimensions, 'width') ?? null,
    height: visualWorkerMetric(asyncVisualProof.dimensions, 'height') ?? null,
    changedPixels: visualWorkerMetric(metricsSource, 'changedPixels', 'changed_pixels') ?? 0,
    changed_pixels: visualWorkerMetric(metricsSource, 'changedPixels', 'changed_pixels') ?? 0,
    changedPixelRatio,
    changed_pixel_ratio: changedPixelRatio,
    meanAbsDelta8bit,
    mean_abs_delta_8bit: meanAbsDelta8bit,
    perceptualDiff: meanAbsDelta8bit / 255,
    perceptual_diff: meanAbsDelta8bit / 255,
    visiblePixelCount: visualWorkerMetric(
      metricsSource,
      'visiblePixelCount',
      'visible_pixel_count',
    ) ?? 0,
    visible_pixel_count: visualWorkerMetric(
      metricsSource,
      'visiblePixelCount',
      'visible_pixel_count',
    ) ?? 0,
  };
  const artifacts = {
    beforeImage: beforeLocator?.storage?.localPath ?? null,
    before_image: beforeLocator?.storage?.localPath ?? null,
    afterImage: afterLocator?.storage?.localPath ?? null,
    after_image: afterLocator?.storage?.localPath ?? null,
    diffImage: diffPath ?? diffLocator?.storage?.localPath ?? null,
    diff_image: diffPath ?? diffLocator?.storage?.localPath ?? null,
    beforeImageHash: beforeLocator?.contentHash ?? null,
    before_image_hash: beforeLocator?.contentHash ?? null,
    afterImageHash: afterLocator?.contentHash ?? null,
    after_image_hash: afterLocator?.contentHash ?? null,
    diffImageHash: diffLocator?.contentHash
      ?? asyncVisualProof.diffArtifact?.hash
      ?? asyncVisualProof.diff_artifact?.hash
      ?? null,
    diff_image_hash: diffLocator?.contentHash
      ?? asyncVisualProof.diffArtifact?.hash
      ?? asyncVisualProof.diff_artifact?.hash
      ?? null,
    artifactCasLocators,
    artifact_cas_locators: artifactCasLocators,
  };
  const transportEvidence = await visualArtifactTransportEvidence({
    artifactCasLocators,
  }, {
    artifactRoot: casRoot,
    allowedRoots: [casRoot],
    requireReadableBytes: true,
  });

  return {
    accepted: asyncVisualProof.accepted === true,
    acceptedAsAsyncVisualMetrics: asyncVisualProof.acceptedAsAsyncVisualMetrics === true,
    accepted_as_async_visual_metrics: asyncVisualProof.acceptedAsAsyncVisualMetrics === true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    proofAuthority: 'async_visual_metrics_and_transport_only',
    proof_authority: 'async_visual_metrics_and_transport_only',
    casRoot,
    cas_root: casRoot,
    metrics,
    artifacts,
    visualArtifacts: artifacts,
    visual_artifacts: artifacts,
    artifactCasLocators,
    artifact_cas_locators: artifactCasLocators,
    visualArtifactTransportEvidence: transportEvidence,
    visual_artifact_transport_evidence: transportEvidence,
    asyncVisualProofJob: job,
    async_visual_proof_job: job,
    proofReady: asyncVisualProof.eventType === 'proof_ready',
    proof_ready: asyncVisualProof.eventType === 'proof_ready',
    proofPending: false,
    proof_pending: false,
    asyncVisualProof,
    async_visual_proof: asyncVisualProof,
  };
}

export async function buildAsyncVisualProofBundle(input = {}, options = {}) {
  const job = await createAsyncVisualProofJob(input, options);
  const diffPath = pathTextOrNull(job.request?.diffPath ?? job.request?.diff_path);
  const casRoot = pathTextOrNull(job.casRoot ?? job.cas_root);
  const artifactDir = pathTextOrNull(job.artifactDir ?? job.artifact_dir);
  return completeAsyncVisualProofJob(job, {
    ...options,
    casRoot: options.casRoot ?? options.cas_root ?? casRoot,
    allowedRoots: uniquePaths(
      casRoot,
      ...(Array.isArray(options.allowedRoots) ? options.allowedRoots : []),
    ),
    allowedOutputRoots: uniquePaths(
      artifactDir,
      diffPath ? path.dirname(diffPath) : null,
      ...(Array.isArray(options.allowedOutputRoots) ? options.allowedOutputRoots : []),
    ),
  });
}
