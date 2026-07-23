import path from 'node:path';
import { mkdir, open, readFile } from 'node:fs/promises';
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
export const GPU_HMR_IMAGE_EVIDENCE_MAX_ENCODED_BYTES = 32 * 1024 * 1024;
export const GPU_HMR_IMAGE_EVIDENCE_MAX_DECODED_BYTES = 256 * 1024 * 1024;
export const GPU_HMR_IMAGE_EVIDENCE_MAX_DIMENSION = 16_384;
export const GPU_HMR_IMAGE_EVIDENCE_MAX_PIXELS = 64 * 1024 * 1024;
const MCP_CAPTURE_MANIFEST_SCHEMA_VERSION = 'synthi.mcp.capture_manifest.v1';
export const GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION =
  'synthi.gpu_hmr.deterministic_visual_mode.v1';
export const GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_visual_control_observation.v3';
export const GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_AUTHORITY =
  'target_emitted_visual_control_diagnostics_only_not_gpu_hmr_proof';
export const GPU_HMR_RUNTIME_VISUAL_CONTROL_STATE_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_visual_control_state.v1';
export const GPU_HMR_RUNTIME_VISUAL_CONTROL_STATE_AUTHORITY =
  'target_process_runtime_visual_control_state';
export const GPU_HMR_RUNTIME_VISUAL_FRAME_BINDING_AUTHORITY =
  'independent_verifier_bound_capture_bytes';
export const GPU_HMR_RUNTIME_VISUAL_DIMENSIONS_BINDING_AUTHORITY =
  'independent_verifier_decoded_capture_dimensions';
export const GPU_HMR_RUNTIME_VISUAL_DEVICE_BINDING_AUTHORITY =
  'independent_runtime_trace_device_identity';
export const GPU_HMR_RUNTIME_VISUAL_DISPATCH_BINDING_AUTHORITY =
  'independent_runtime_trace_dispatch_identity';
export const GPU_HMR_RUNTIME_VISUAL_CONTROL_PAIR_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_visual_control_pair.v3';
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

function consensusBool(...values) {
  const observed = values.filter((value) => typeof value === 'boolean');
  const distinct = new Set(observed);
  return {
    value: distinct.size === 1 ? observed[0] : null,
    conflict: distinct.size > 1,
  };
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

function rawObservationHashes(...values) {
  return values
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map(textOrNull)
    .filter(Boolean);
}

function normalizeConvergenceSamples(value) {
  return (Array.isArray(value) ? value : [])
    .filter((sample) => isObject(sample))
    .map((sample) => {
      const observationHash = textOrNull(
        sample.sample_hash
        ?? sample.sampleHash
        ?? sample.observation_hash
        ?? sample.observationHash
        ?? sample.frame_hash
        ?? sample.frameHash
        ?? sample.image_hash
        ?? sample.imageHash
        ?? sample.source_frame_hash
        ?? sample.sourceFrameHash,
      );
      const artifactHash = textOrNull(sample.artifact_hash ?? sample.artifactHash);
      const sampleIndex = finiteNumberOrNull(
        sample.sample
        ?? sample.sample_index
        ?? sample.sampleIndex
        ?? sample.frame
        ?? sample.frame_index
        ?? sample.frameIndex,
      );
      const afterDispatch = boolOrNull(
        sample.after_dispatch
        ?? sample.afterDispatch
        ?? sample.after_epoch_dispatch
        ?? sample.afterEpochDispatch,
      );
      return {
        sample: sampleIndex,
        frame: sampleIndex,
        epoch: textOrNull(sample.epoch ?? sample.epoch_id ?? sample.epochId),
        metric_value: finiteNumberOrNull(
          sample.metric_value ?? sample.metricValue ?? sample.value,
        ),
        sample_hash: observationHash,
        frame_hash: observationHash,
        artifact_hash: artifactHash,
        hash_source: observationHash ? 'sample_hash' : artifactHash ? 'artifact_hash' : null,
        after_dispatch: afterDispatch,
        after_epoch_dispatch: afterDispatch,
      };
    });
}

function addGate(failedGates, code, detail = {}) {
  failedGates.push({ code, ...detail });
}

function normalizeConvergenceWindow(value = {}) {
  const window = isObject(value) ? value : {};
  const metricValue = textOrNull(window.metric?.value ?? window.metric);
  const sampleStart = finiteNumberOrNull(
    window.sample_start
    ?? window.sampleStart
    ?? window.observation_start
    ?? window.observationStart
    ?? window.frame_start
    ?? window.frameStart,
  );
  const sampleEnd = finiteNumberOrNull(
    window.sample_end
    ?? window.sampleEnd
    ?? window.observation_end
    ?? window.observationEnd
    ?? window.frame_end
    ?? window.frameEnd,
  );
  const samples = normalizeConvergenceSamples(window.samples);
  const rawDeclaredObservationHashes = rawObservationHashes(
    window.sample_hashes,
    window.sampleHashes,
    window.observation_hashes,
    window.observationHashes,
    window.frame_hashes,
    window.frameHashes,
    window.post_dispatch_sample_hashes,
    window.postDispatchSampleHashes,
    window.post_epoch_frame_hashes,
    window.postEpochFrameHashes,
  );
  const observationHashes = compactStringList(rawDeclaredObservationHashes);
  const rawPreDispatchSampleHashes = rawObservationHashes(
    window.pre_dispatch_sample_hashes,
    window.preDispatchSampleHashes,
    window.pre_epoch_frame_hashes,
    window.preEpochFrameHashes,
  );
  const preDispatchSampleHashes = compactStringList(rawPreDispatchSampleHashes);
  const rawPostDispatchSampleHashes = rawObservationHashes(
    window.post_dispatch_sample_hashes,
    window.postDispatchSampleHashes,
    window.post_epoch_frame_hashes,
    window.postEpochFrameHashes,
  );
  const postDispatchSampleHashes = compactStringList(rawPostDispatchSampleHashes);
  const sampleCount = finiteNumberOrNull(window.sample_count ?? window.sampleCount)
    ?? (samples.length > 0 ? samples.length : null)
    ?? (observationHashes.length > 0 ? observationHashes.length : null);
  const rawSampleObservationHashes = samples.map((sample) => sample.sample_hash).filter(Boolean);
  const sampleObservationHashes = compactStringList(rawSampleObservationHashes);
  const artifactHashes = compactStringList([
    ...(Array.isArray(window.artifact_hashes) ? window.artifact_hashes : []),
    ...(Array.isArray(window.artifactHashes) ? window.artifactHashes : []),
    window.artifact_hash,
    window.artifactHash,
    ...samples.map((sample) => sample.artifact_hash),
  ]);
  return {
    sample_start: sampleStart,
    sample_end: sampleEnd,
    frame_start: sampleStart,
    frame_end: sampleEnd,
    metric: metricValue ? { value: metricValue } : null,
    min_samples:
      finiteNumberOrNull(
        window.min_samples
        ?? window.minSamples
        ?? window.min_frames
        ?? window.minFrames,
      )
      ?? (
        sampleStart !== null && sampleEnd !== null
          ? Math.max(0, sampleEnd - sampleStart + 1)
          : null
      ),
    min_frames:
      finiteNumberOrNull(
        window.min_samples
        ?? window.minSamples
        ?? window.min_frames
        ?? window.minFrames,
      )
      ?? (
        sampleStart !== null && sampleEnd !== null
          ? Math.max(0, sampleEnd - sampleStart + 1)
          : null
      ),
    sample_count: sampleCount,
    samples,
    sample_hashes: sampleObservationHashes,
    raw_sample_hashes: rawSampleObservationHashes,
    observation_hashes: observationHashes,
    raw_observation_hashes: rawDeclaredObservationHashes,
    pre_dispatch_sample_hashes: preDispatchSampleHashes,
    raw_pre_dispatch_sample_hashes: rawPreDispatchSampleHashes,
    post_dispatch_sample_hashes: postDispatchSampleHashes,
    raw_post_dispatch_sample_hashes: rawPostDispatchSampleHashes,
    sample_frame_hashes: sampleObservationHashes,
    frame_hashes: observationHashes,
    pre_epoch_frame_hashes: preDispatchSampleHashes,
    post_epoch_frame_hashes: postDispatchSampleHashes,
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

function convergenceWindowAccepted(window) {
  const metric = window.metric?.value ?? null;
  const sampleRangeValid = window.sample_start !== null
    && window.sample_end !== null
    && window.sample_end >= window.sample_start;
  if (!sampleRangeValid || !metric) return false;
  const requiredSamples = Math.max(2, finiteNumberOrNull(window.min_samples) ?? 2);
  const rawHashes = [...window.raw_sample_hashes, ...window.raw_observation_hashes];
  const canonicalHashes = rawHashes.map(sha256ContentAddress).filter(Boolean);
  const uniqueHashes = compactStringList(canonicalHashes);
  const postDispatchHashes = compactStringList([
    ...window.post_dispatch_sample_hashes.map(sha256ContentAddress),
    ...window.samples
      .filter((sample) => sample.after_dispatch === true)
      .map((sample) => sha256ContentAddress(sample.sample_hash)),
  ]);
  const sampleCountMatches = window.sample_count === null
    || window.sample_count === uniqueHashes.length;
  const structuredSamplesOrdered = window.samples.every(
    (sample) => sample.after_dispatch === true,
  );
  const hasSampleEvidence = uniqueHashes.length >= requiredSamples
    && canonicalHashes.length === rawHashes.length
    && uniqueHashes.length === canonicalHashes.length
    && postDispatchHashes.length >= requiredSamples
    && sampleCountMatches
    && structuredSamplesOrdered;
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
  const manifest = screenshotCaptureManifest(shot) ?? {};
  return finiteNumberOrNull(
    shot?.seq
    ?? shot?.frame_seq
    ?? shot?.frameSeq
    ?? meta.seq
    ?? meta.frame_seq
    ?? meta.frameSeq
    ?? manifest.frame_seq
    ?? manifest.frameSeq,
  );
}

function screenshotTimestampMs(shot) {
  const meta = isObject(shot?.screenshot_metadata ?? shot?.screenshotMetadata)
    ? (shot.screenshot_metadata ?? shot.screenshotMetadata)
    : {};
  const manifest = screenshotCaptureManifest(shot) ?? {};
  return finiteNumberOrNull(
    shot?.ts
    ?? shot?.timestamp_ms
    ?? shot?.timestampMs
    ?? meta.ts
    ?? meta.timestamp_ms
    ?? meta.timestampMs
    ?? manifest.frame_ts_ms
    ?? manifest.frameTsMs,
  );
}

function screenshotCaptureManifest(shot) {
  const meta = isObject(shot?.screenshot_metadata ?? shot?.screenshotMetadata ?? shot?.meta)
    ? (shot.screenshot_metadata ?? shot.screenshotMetadata ?? shot.meta)
    : {};
  return isObject(shot?.capture_manifest ?? shot?.captureManifest)
    ? (shot.capture_manifest ?? shot.captureManifest)
    : isObject(meta.capture_manifest ?? meta.captureManifest)
      ? (meta.capture_manifest ?? meta.captureManifest)
      : null;
}

function screenshotImageHash(shot) {
  const meta = isObject(shot?.screenshot_metadata ?? shot?.screenshotMetadata ?? shot?.meta)
    ? (shot.screenshot_metadata ?? shot.screenshotMetadata ?? shot.meta)
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

function captureManifestSessionId(manifest) {
  return textOrNull(manifest?.session_id ?? manifest?.sessionId);
}

function captureManifestVerified(shot, gate = null) {
  const manifest = screenshotCaptureManifest(shot);
  if (!manifest) return false;
  if (
    textOrNull(manifest.schema_version ?? manifest.schemaVersion)
    !== MCP_CAPTURE_MANIFEST_SCHEMA_VERSION
  ) {
    return false;
  }
  const imageHash = screenshotImageHash(shot);
  const manifestImageHash = captureManifestImageHash(manifest);
  if (!/^sha256:[a-f0-9]{64}$/i.test(manifestImageHash ?? '')) return false;
  if (imageHash && imageHash !== manifestImageHash) return false;
  if (!/^sha256:[a-f0-9]{64}$/i.test(captureManifestFrameHash(manifest) ?? '')) return false;
  if (finiteNumberOrNull(manifest.image_byte_length ?? manifest.imageByteLength) <= 0) return false;
  if (!captureManifestSessionId(manifest)) return false;
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

export function mcpFrameGateSatisfiedByCaptureChain(
  waitOrGate,
  gateScreenshot,
  selectedScreenshot,
) {
  if (!mcpFrameGateSatisfiedByScreenshot(waitOrGate, gateScreenshot)) return false;
  if (!captureManifestVerified(selectedScreenshot)) return false;
  const gateManifest = screenshotCaptureManifest(gateScreenshot);
  const selectedManifest = screenshotCaptureManifest(selectedScreenshot);
  if (
    !gateManifest
    || !selectedManifest
    || captureManifestSessionId(gateManifest) !== captureManifestSessionId(selectedManifest)
  ) {
    return false;
  }
  const gateSeq = screenshotFrameSeq(gateScreenshot);
  const selectedSeq = screenshotFrameSeq(selectedScreenshot);
  const gateTs = screenshotTimestampMs(gateScreenshot);
  const selectedTs = screenshotTimestampMs(selectedScreenshot);
  if (gateSeq === null && gateTs === null) return false;
  if (gateSeq !== null && (selectedSeq === null || selectedSeq < gateSeq)) return false;
  if (gateTs !== null && (selectedTs === null || selectedTs < gateTs)) return false;
  return mcpFrameAtOrAfterFrameGate(waitOrGate, selectedScreenshot);
}

export function deterministicVisualModeFromMcpEvidence(input = {}) {
  const evidence = isObject(input) ? input : {};
  const after = evidence.after ?? evidence.afterScreenshot ?? null;
  const gateCapture = evidence.gate_capture ?? evidence.gateCapture ?? after;
  const frameBoundary = mcpFrameGateSatisfiedByScreenshot(evidence.wait ?? evidence, after)
    || mcpFrameGateSatisfiedByCaptureChain(evidence.wait ?? evidence, gateCapture, after);
  return {
    ...normalizeGpuHmrDeterministicVisualMode({
      output_observation_after_dispatch: frameBoundary === true ? true : null,
      output_observation_ordering_proven: frameBoundary === true ? true : null,
    }),
    evidence_authority: 'verified_mcp_capture_observations_only',
    capture_chain_verified: frameBoundary === true,
    state_dependency_binding_observed: false,
  };
}

function sha256ContentAddress(value) {
  const text = textOrNull(value);
  return text && /^sha256:[a-f0-9]{64}$/i.test(text) ? text.toLowerCase() : null;
}

function nonNegativeIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function positiveIntegerOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function monotonicNsOrNull(value) {
  const text = typeof value === 'bigint'
    ? String(value)
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : textOrNull(value);
  if (!text || !/^\d+$/.test(text)) return null;
  try {
    return BigInt(text) >= 0n ? text : null;
  } catch {
    return null;
  }
}

function normalizedRuntimeVisualControlState(input = {}) {
  const state = isObject(input) ? input : {};
  return {
    schema_version: textOrNull(state.schema_version ?? state.schemaVersion),
    proof_authority: textOrNull(state.proof_authority ?? state.proofAuthority),
    phase: textOrNull(state.phase),
    runtime_session: textOrNull(state.runtime_session ?? state.runtimeSession),
    process_id: textOrNull(state.process_id ?? state.processId),
    capture_event_id: textOrNull(state.capture_event_id ?? state.captureEventId),
    frame_timestamp_monotonic_ns: monotonicNsOrNull(
      state.frame_timestamp_monotonic_ns ?? state.frameTimestampMonotonicNs,
    ),
    after_epoch_dispatch: boolOrNull(
      state.after_epoch_dispatch ?? state.afterEpochDispatch,
    ),
    capture_synchronized: boolOrNull(
      state.capture_synchronized ?? state.captureSynchronized,
    ),
    presentation_boundary_observed: boolOrNull(
      state.presentation_boundary_observed ?? state.presentationBoundaryObserved,
    ),
    presentation_boundary_kind: textOrNull(
      state.presentation_boundary_kind ?? state.presentationBoundaryKind,
    ),
    fixed_seed: boolOrNull(state.fixed_seed ?? state.fixedSeed),
    seed_state_token: textOrNull(state.seed_state_token ?? state.seedStateToken),
    camera_state_token: textOrNull(state.camera_state_token ?? state.cameraStateToken),
    temporal_accumulation_present: boolOrNull(
      state.temporal_accumulation_present ?? state.temporalAccumulationPresent,
    ),
    temporal_accumulation_disabled: boolOrNull(
      state.temporal_accumulation_disabled ?? state.temporalAccumulationDisabled,
    ),
    temporal_accumulation_not_applicable: boolOrNull(
      state.temporal_accumulation_not_applicable
      ?? state.temporalAccumulationNotApplicable,
    ),
    taa_present: boolOrNull(state.taa_present ?? state.taaPresent),
    taa_disabled: boolOrNull(state.taa_disabled ?? state.taaDisabled),
    taa_not_applicable: boolOrNull(
      state.taa_not_applicable ?? state.taaNotApplicable,
    ),
    denoiser_present: boolOrNull(state.denoiser_present ?? state.denoiserPresent),
    denoiser_disabled: boolOrNull(
      state.denoiser_disabled ?? state.denoiserDisabled,
    ),
    denoiser_not_applicable: boolOrNull(
      state.denoiser_not_applicable ?? state.denoiserNotApplicable,
    ),
    presentation_image_count: positiveIntegerOrNull(
      state.presentation_image_count ?? state.presentationImageCount,
    ),
    warmup_frames: nonNegativeIntegerOrNull(state.warmup_frames ?? state.warmupFrames),
    width: positiveIntegerOrNull(state.width),
    height: positiveIntegerOrNull(state.height),
    accepted_for_gpu_hmr: boolOrNull(
      state.accepted_for_gpu_hmr ?? state.acceptedForGpuHmr,
    ),
    gpu_hmr_success: boolOrNull(state.gpu_hmr_success ?? state.gpuHmrSuccess),
    can_satisfy_runtime_proof: boolOrNull(
      state.can_satisfy_runtime_proof ?? state.canSatisfyRuntimeProof,
    ),
    can_satisfy_dispatch_proof: boolOrNull(
      state.can_satisfy_dispatch_proof ?? state.canSatisfyDispatchProof,
    ),
  };
}

export function parseRuntimeVisualControlStateLine(sourceLine) {
  const line = textOrNull(sourceLine);
  const marker = '[gpu-runtime-boundary] visual_control_observation ';
  const markerIndex = line?.indexOf(marker) ?? -1;
  const failedGates = [];
  let parsed = null;
  if (markerIndex < 0) {
    failedGates.push('runtime_visual_control_state_marker_missing');
  } else {
    const payloadText = line.slice(markerIndex + marker.length).trim();
    try {
      parsed = JSON.parse(payloadText);
    } catch {
      failedGates.push('runtime_visual_control_state_json_invalid');
    }
  }
  if (parsed !== null && !isObject(parsed)) {
    failedGates.push('runtime_visual_control_state_payload_invalid');
  }
  const state = normalizedRuntimeVisualControlState(parsed);
  if (state.schema_version !== GPU_HMR_RUNTIME_VISUAL_CONTROL_STATE_SCHEMA_VERSION) {
    failedGates.push('runtime_visual_control_state_schema_invalid');
  }
  if (state.proof_authority !== GPU_HMR_RUNTIME_VISUAL_CONTROL_STATE_AUTHORITY) {
    failedGates.push('runtime_visual_control_state_authority_invalid');
  }
  if (
    state.accepted_for_gpu_hmr !== false
    || state.gpu_hmr_success !== false
    || state.can_satisfy_runtime_proof !== false
    || state.can_satisfy_dispatch_proof !== false
  ) {
    failedGates.push('runtime_visual_control_state_authority_claim_invalid');
  }
  const uniqueFailedGates = compactStringList(failedGates);
  return {
    accepted: uniqueFailedGates.length === 0,
    state,
    statePayloadHash: sha256Text(stableJson(state)),
    state_payload_hash: sha256Text(stableJson(state)),
    sourceLine: line,
    source_line: line,
    sourceLineHash: line ? sha256Text(line) : null,
    source_line_hash: line ? sha256Text(line) : null,
    failedGates: uniqueFailedGates,
    failed_gates: uniqueFailedGates,
  };
}

export function materializeRuntimeVisualControlObservation(input = {}) {
  const sourceLine = input.source_line ?? input.sourceLine;
  const parsed = parseRuntimeVisualControlStateLine(sourceLine);
  const state = parsed.state;
  const record = {
    schema_version: GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_SCHEMA_VERSION,
    proof_authority: GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_AUTHORITY,
    phase: state.phase,
    runtime_session: state.runtime_session,
    process_id: state.process_id,
    device_identity: textOrNull(input.device_identity ?? input.deviceIdentity),
    capture_event_id: state.capture_event_id,
    frame_hash: sha256ContentAddress(input.frame_hash ?? input.frameHash),
    frame_hash_binding_authority: GPU_HMR_RUNTIME_VISUAL_FRAME_BINDING_AUTHORITY,
    frame_dimensions_binding_authority:
      GPU_HMR_RUNTIME_VISUAL_DIMENSIONS_BINDING_AUTHORITY,
    device_identity_binding_authority: GPU_HMR_RUNTIME_VISUAL_DEVICE_BINDING_AUTHORITY,
    dispatch_identity_binding_authority: GPU_HMR_RUNTIME_VISUAL_DISPATCH_BINDING_AUTHORITY,
    width: positiveIntegerOrNull(input.width),
    height: positiveIntegerOrNull(input.height),
    frame_timestamp_monotonic_ns: state.frame_timestamp_monotonic_ns,
    source_line_hash: parsed.sourceLineHash,
    source_line: parsed.sourceLine,
    source_line_index: nonNegativeIntegerOrNull(
      input.source_line_index ?? input.sourceLineIndex,
    ),
    state_payload_hash: parsed.statePayloadHash,
    state_line_accepted: parsed.accepted,
    state_line_failed_gates: parsed.failedGates,
    dispatch_id: textOrNull(input.dispatch_id ?? input.dispatchId),
    after_epoch_dispatch: state.after_epoch_dispatch,
    capture_synchronized: state.capture_synchronized,
    presentation_boundary_observed: state.presentation_boundary_observed,
    presentation_boundary_kind: state.presentation_boundary_kind,
    fixed_seed: state.fixed_seed,
    seed_state_token: state.seed_state_token,
    seed_policy_hash: state.seed_state_token ? sha256Text(state.seed_state_token) : null,
    camera_state_token: state.camera_state_token,
    camera_state_hash: state.camera_state_token ? sha256Text(state.camera_state_token) : null,
    temporal_accumulation_present: state.temporal_accumulation_present,
    temporal_accumulation_disabled: state.temporal_accumulation_disabled,
    temporal_accumulation_not_applicable: state.temporal_accumulation_not_applicable,
    taa_present: state.taa_present,
    taa_disabled: state.taa_disabled,
    taa_not_applicable: state.taa_not_applicable,
    denoiser_present: state.denoiser_present,
    denoiser_disabled: state.denoiser_disabled,
    denoiser_not_applicable: state.denoiser_not_applicable,
    presentation_image_count: state.presentation_image_count,
    warmup_frames: state.warmup_frames,
    target_reported_width: state.width,
    target_reported_height: state.height,
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    can_satisfy_runtime_proof: false,
    can_satisfy_dispatch_proof: false,
  };
  return {
    ...record,
    observation_hash: runtimeVisualControlObservationHash(record),
  };
}

function normalizedRuntimeVisualControlObservation(input = {}) {
  const observation = isObject(input) ? input : {};
  return {
    schema_version: textOrNull(observation.schema_version ?? observation.schemaVersion),
    proof_authority: textOrNull(observation.proof_authority ?? observation.proofAuthority),
    phase: textOrNull(observation.phase),
    runtime_session: textOrNull(observation.runtime_session ?? observation.runtimeSession),
    process_id: textOrNull(observation.process_id ?? observation.processId),
    device_identity: textOrNull(observation.device_identity ?? observation.deviceIdentity),
    capture_event_id: textOrNull(observation.capture_event_id ?? observation.captureEventId),
    frame_hash: sha256ContentAddress(observation.frame_hash ?? observation.frameHash),
    frame_hash_binding_authority: textOrNull(
      observation.frame_hash_binding_authority ?? observation.frameHashBindingAuthority,
    ),
    frame_dimensions_binding_authority: textOrNull(
      observation.frame_dimensions_binding_authority
      ?? observation.frameDimensionsBindingAuthority,
    ),
    device_identity_binding_authority: textOrNull(
      observation.device_identity_binding_authority
      ?? observation.deviceIdentityBindingAuthority,
    ),
    dispatch_identity_binding_authority: textOrNull(
      observation.dispatch_identity_binding_authority
      ?? observation.dispatchIdentityBindingAuthority,
    ),
    width: positiveIntegerOrNull(observation.width),
    height: positiveIntegerOrNull(observation.height),
    frame_timestamp_monotonic_ns: monotonicNsOrNull(
      observation.frame_timestamp_monotonic_ns ?? observation.frameTimestampMonotonicNs,
    ),
    source_line_hash: sha256ContentAddress(
      observation.source_line_hash ?? observation.sourceLineHash,
    ),
    source_line: textOrNull(observation.source_line ?? observation.sourceLine),
    source_line_index: nonNegativeIntegerOrNull(
      observation.source_line_index ?? observation.sourceLineIndex,
    ),
    state_payload_hash: sha256ContentAddress(
      observation.state_payload_hash ?? observation.statePayloadHash,
    ),
    state_line_accepted: boolOrNull(
      observation.state_line_accepted ?? observation.stateLineAccepted,
    ),
    dispatch_id: textOrNull(observation.dispatch_id ?? observation.dispatchId),
    after_epoch_dispatch: boolOrNull(
      observation.after_epoch_dispatch ?? observation.afterEpochDispatch,
    ),
    capture_synchronized: boolOrNull(
      observation.capture_synchronized ?? observation.captureSynchronized,
    ),
    presentation_boundary_observed: boolOrNull(
      observation.presentation_boundary_observed ?? observation.presentationBoundaryObserved,
    ),
    presentation_boundary_kind: textOrNull(
      observation.presentation_boundary_kind ?? observation.presentationBoundaryKind,
    ),
    fixed_seed: boolOrNull(observation.fixed_seed ?? observation.fixedSeed),
    seed_state_token: textOrNull(
      observation.seed_state_token ?? observation.seedStateToken,
    ),
    seed_policy_hash: sha256ContentAddress(
      observation.seed_policy_hash ?? observation.seedPolicyHash,
    ),
    camera_state_hash: sha256ContentAddress(
      observation.camera_state_hash ?? observation.cameraStateHash,
    ),
    camera_state_token: textOrNull(
      observation.camera_state_token ?? observation.cameraStateToken,
    ),
    temporal_accumulation_present: boolOrNull(
      observation.temporal_accumulation_present ?? observation.temporalAccumulationPresent,
    ),
    temporal_accumulation_disabled: boolOrNull(
      observation.temporal_accumulation_disabled ?? observation.temporalAccumulationDisabled,
    ),
    temporal_accumulation_not_applicable: boolOrNull(
      observation.temporal_accumulation_not_applicable
      ?? observation.temporalAccumulationNotApplicable,
    ),
    taa_present: boolOrNull(observation.taa_present ?? observation.taaPresent),
    taa_disabled: boolOrNull(observation.taa_disabled ?? observation.taaDisabled),
    taa_not_applicable: boolOrNull(
      observation.taa_not_applicable ?? observation.taaNotApplicable,
    ),
    denoiser_present: boolOrNull(observation.denoiser_present ?? observation.denoiserPresent),
    denoiser_disabled: boolOrNull(
      observation.denoiser_disabled ?? observation.denoiserDisabled,
    ),
    denoiser_not_applicable: boolOrNull(
      observation.denoiser_not_applicable ?? observation.denoiserNotApplicable,
    ),
    presentation_image_count: positiveIntegerOrNull(
      observation.presentation_image_count ?? observation.presentationImageCount,
    ),
    warmup_frames: nonNegativeIntegerOrNull(
      observation.warmup_frames ?? observation.warmupFrames,
    ),
    target_reported_width: positiveIntegerOrNull(
      observation.target_reported_width ?? observation.targetReportedWidth,
    ),
    target_reported_height: positiveIntegerOrNull(
      observation.target_reported_height ?? observation.targetReportedHeight,
    ),
    accepted_for_gpu_hmr: boolOrNull(
      observation.accepted_for_gpu_hmr ?? observation.acceptedForGpuHmr,
    ),
    gpu_hmr_success: boolOrNull(observation.gpu_hmr_success ?? observation.gpuHmrSuccess),
    can_satisfy_runtime_proof: boolOrNull(
      observation.can_satisfy_runtime_proof ?? observation.canSatisfyRuntimeProof,
    ),
    can_satisfy_dispatch_proof: boolOrNull(
      observation.can_satisfy_dispatch_proof ?? observation.canSatisfyDispatchProof,
    ),
  };
}

export function runtimeVisualControlObservationHash(input = {}) {
  return sha256Text(stableJson(normalizedRuntimeVisualControlObservation(input)));
}

function runtimeVisualControlObservation(input = {}) {
  const normalized = normalizedRuntimeVisualControlObservation(input);
  return {
    ...normalized,
    observation_hash: sha256ContentAddress(input.observation_hash ?? input.observationHash),
  };
}

function visualControlStateMatches(before, after, prefix) {
  const presentField = `${prefix}_present`;
  const disabledField = `${prefix}_disabled`;
  const notApplicableField = `${prefix}_not_applicable`;
  const fieldsMatch =
    before[presentField] === after[presentField]
    && before[disabledField] === after[disabledField]
    && before[notApplicableField] === after[notApplicableField];
  const controlled =
    before[disabledField] === true
    || (before[presentField] === false && before[notApplicableField] === true);
  return fieldsMatch && controlled;
}

export function evaluateRuntimeVisualControlObservationPair(input = {}) {
  const pair = isObject(input) ? input : {};
  const before = runtimeVisualControlObservation(pair.before);
  const after = runtimeVisualControlObservation(pair.after);
  const expected = isObject(pair.expected) ? pair.expected : {};
  const expectedBeforeFrameHash = sha256ContentAddress(
    expected.before_frame_hash ?? expected.beforeFrameHash,
  );
  const expectedAfterFrameHash = sha256ContentAddress(
    expected.after_frame_hash ?? expected.afterFrameHash,
  );
  const expectedWidth = positiveIntegerOrNull(expected.width);
  const expectedHeight = positiveIntegerOrNull(expected.height);
  const expectedProcessId = textOrNull(expected.process_id ?? expected.processId);
  const expectedDeviceIdentity = textOrNull(
    expected.device_identity ?? expected.deviceIdentity,
  );
  const expectedRuntimeSession = textOrNull(
    expected.runtime_session ?? expected.runtimeSession,
  );
  const expectedDispatchId = textOrNull(expected.dispatch_id ?? expected.dispatchId);
  const expectedDispatchLineIndex = nonNegativeIntegerOrNull(
    expected.dispatch_line_index ?? expected.dispatchLineIndex,
  );
  const expectedDispatchTimestampNs = monotonicNsOrNull(
    expected.dispatch_timestamp_monotonic_ns ?? expected.dispatchTimestampMonotonicNs,
  );
  const failedGates = [];
  const fail = (code) => failedGates.push(code);

  for (const [phase, observation] of [['before', before], ['after', after]]) {
    if (observation.schema_version !== GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_SCHEMA_VERSION) {
      fail(`runtime_visual_control_${phase}_schema_invalid`);
    }
    if (observation.proof_authority !== GPU_HMR_RUNTIME_VISUAL_CONTROL_OBSERVATION_AUTHORITY) {
      fail(`runtime_visual_control_${phase}_authority_invalid`);
    }
    if (observation.phase !== phase) fail(`runtime_visual_control_${phase}_phase_invalid`);
    if (!observation.runtime_session) fail(`runtime_visual_control_${phase}_session_missing`);
    if (!observation.process_id) fail(`runtime_visual_control_${phase}_process_missing`);
    if (!observation.device_identity) fail(`runtime_visual_control_${phase}_device_missing`);
    if (!observation.capture_event_id) fail(`runtime_visual_control_${phase}_capture_event_missing`);
    if (!observation.frame_hash) fail(`runtime_visual_control_${phase}_frame_hash_missing`);
    if (observation.frame_hash_binding_authority !== GPU_HMR_RUNTIME_VISUAL_FRAME_BINDING_AUTHORITY) {
      fail(`runtime_visual_control_${phase}_frame_binding_authority_invalid`);
    }
    if (
      observation.frame_dimensions_binding_authority
      !== GPU_HMR_RUNTIME_VISUAL_DIMENSIONS_BINDING_AUTHORITY
    ) {
      fail(`runtime_visual_control_${phase}_dimensions_binding_authority_invalid`);
    }
    if (
      observation.device_identity_binding_authority
      !== GPU_HMR_RUNTIME_VISUAL_DEVICE_BINDING_AUTHORITY
    ) {
      fail(`runtime_visual_control_${phase}_device_binding_authority_invalid`);
    }
    if (
      observation.dispatch_identity_binding_authority
      !== GPU_HMR_RUNTIME_VISUAL_DISPATCH_BINDING_AUTHORITY
    ) {
      fail(`runtime_visual_control_${phase}_dispatch_binding_authority_invalid`);
    }
    if (!observation.width || !observation.height) {
      fail(`runtime_visual_control_${phase}_resolution_missing`);
    }
    if (!observation.frame_timestamp_monotonic_ns) {
      fail(`runtime_visual_control_${phase}_timestamp_missing`);
    }
    if (
      !observation.source_line
      || !observation.source_line_hash
      || observation.source_line_index === null
    ) {
      fail(`runtime_visual_control_${phase}_source_provenance_missing`);
    } else if (sha256Text(observation.source_line) !== observation.source_line_hash) {
      fail(`runtime_visual_control_${phase}_source_line_hash_mismatch`);
    }
    const parsedState = parseRuntimeVisualControlStateLine(observation.source_line);
    if (observation.state_line_accepted !== true || parsedState.accepted !== true) {
      fail(`runtime_visual_control_${phase}_target_state_invalid`);
    }
    if (
      !observation.state_payload_hash
      || observation.state_payload_hash !== parsedState.statePayloadHash
    ) {
      fail(`runtime_visual_control_${phase}_target_state_hash_mismatch`);
    }
    const targetState = parsedState.state;
    const targetProjection = {
      phase: observation.phase,
      runtime_session: observation.runtime_session,
      process_id: observation.process_id,
      capture_event_id: observation.capture_event_id,
      frame_timestamp_monotonic_ns: observation.frame_timestamp_monotonic_ns,
      after_epoch_dispatch: observation.after_epoch_dispatch,
      capture_synchronized: observation.capture_synchronized,
      presentation_boundary_observed: observation.presentation_boundary_observed,
      presentation_boundary_kind: observation.presentation_boundary_kind,
      fixed_seed: observation.fixed_seed,
      seed_state_token: observation.seed_state_token,
      camera_state_token: observation.camera_state_token,
      temporal_accumulation_present: observation.temporal_accumulation_present,
      temporal_accumulation_disabled: observation.temporal_accumulation_disabled,
      temporal_accumulation_not_applicable: observation.temporal_accumulation_not_applicable,
      taa_present: observation.taa_present,
      taa_disabled: observation.taa_disabled,
      taa_not_applicable: observation.taa_not_applicable,
      denoiser_present: observation.denoiser_present,
      denoiser_disabled: observation.denoiser_disabled,
      denoiser_not_applicable: observation.denoiser_not_applicable,
      presentation_image_count: observation.presentation_image_count,
      warmup_frames: observation.warmup_frames,
      width: observation.target_reported_width,
      height: observation.target_reported_height,
      accepted_for_gpu_hmr: observation.accepted_for_gpu_hmr,
      gpu_hmr_success: observation.gpu_hmr_success,
      can_satisfy_runtime_proof: observation.can_satisfy_runtime_proof,
      can_satisfy_dispatch_proof: observation.can_satisfy_dispatch_proof,
    };
    const expectedTargetProjection = { ...targetState };
    delete expectedTargetProjection.schema_version;
    delete expectedTargetProjection.proof_authority;
    if (stableJson(targetProjection) !== stableJson(expectedTargetProjection)) {
      fail(`runtime_visual_control_${phase}_target_state_projection_mismatch`);
    }
    if (
      !observation.seed_state_token
      || observation.seed_policy_hash !== sha256Text(observation.seed_state_token)
      || observation.fixed_seed !== true
    ) {
      fail(`runtime_visual_control_${phase}_seed_policy_unproven`);
    }
    if (
      !observation.camera_state_token
      || observation.camera_state_hash !== sha256Text(observation.camera_state_token)
    ) {
      fail(`runtime_visual_control_${phase}_camera_state_missing`);
    }
    if (observation.capture_synchronized !== true) {
      fail(`runtime_visual_control_${phase}_capture_unsynchronized`);
    }
    if (observation.presentation_boundary_observed !== true) {
      fail(`runtime_visual_control_${phase}_presentation_boundary_missing`);
    }
    if (!observation.presentation_boundary_kind) {
      fail(`runtime_visual_control_${phase}_presentation_boundary_kind_missing`);
    }
    if (!observation.presentation_image_count) {
      fail(`runtime_visual_control_${phase}_presentation_image_count_missing`);
    }
    if (
      observation.accepted_for_gpu_hmr !== false
      || observation.gpu_hmr_success !== false
      || observation.can_satisfy_runtime_proof !== false
      || observation.can_satisfy_dispatch_proof !== false
    ) {
      fail(`runtime_visual_control_${phase}_authority_claim_invalid`);
    }
    const suppliedHash = observation.observation_hash;
    const recomputedHash = runtimeVisualControlObservationHash(observation);
    if (!suppliedHash || suppliedHash !== recomputedHash) {
      fail(`runtime_visual_control_${phase}_observation_hash_mismatch`);
    }
  }

  if (!expectedBeforeFrameHash || before.frame_hash !== expectedBeforeFrameHash) {
    fail('runtime_visual_control_before_frame_hash_mismatch');
  }
  if (!expectedAfterFrameHash || after.frame_hash !== expectedAfterFrameHash) {
    fail('runtime_visual_control_after_frame_hash_mismatch');
  }
  if (
    !expectedWidth
    || !expectedHeight
    || before.width !== expectedWidth
    || before.height !== expectedHeight
    || after.width !== expectedWidth
    || after.height !== expectedHeight
  ) {
    fail('runtime_visual_control_decoded_resolution_mismatch');
  }
  if (
    before.target_reported_width !== expectedWidth
    || before.target_reported_height !== expectedHeight
    || after.target_reported_width !== expectedWidth
    || after.target_reported_height !== expectedHeight
  ) {
    fail('runtime_visual_control_target_reported_resolution_mismatch');
  }
  if (!expectedProcessId || before.process_id !== expectedProcessId || after.process_id !== expectedProcessId) {
    fail('runtime_visual_control_process_identity_mismatch');
  }
  if (
    !expectedDeviceIdentity
    || before.device_identity !== expectedDeviceIdentity
    || after.device_identity !== expectedDeviceIdentity
  ) {
    fail('runtime_visual_control_device_identity_mismatch');
  }
  if (
    !expectedRuntimeSession
    || before.runtime_session !== expectedRuntimeSession
    || after.runtime_session !== expectedRuntimeSession
  ) {
    fail('runtime_visual_control_session_identity_mismatch');
  }
  if (before.runtime_session !== after.runtime_session || before.process_id !== after.process_id) {
    fail('runtime_visual_control_pair_identity_mismatch');
  }
  if (before.capture_event_id === after.capture_event_id) {
    fail('runtime_visual_control_capture_event_reused');
  }
  if (!expectedDispatchId || after.dispatch_id !== expectedDispatchId) {
    fail('runtime_visual_control_dispatch_id_mismatch');
  }
  if (before.after_epoch_dispatch !== false || after.after_epoch_dispatch !== true) {
    fail('runtime_visual_control_epoch_order_unproven');
  }
  if (
    expectedDispatchLineIndex === null
    || after.source_line_index === null
    || after.source_line_index <= expectedDispatchLineIndex
  ) {
    fail('runtime_visual_control_dispatch_line_order_unproven');
  }
  if (
    expectedDispatchTimestampNs
    && (!after.frame_timestamp_monotonic_ns
      || BigInt(after.frame_timestamp_monotonic_ns) <= BigInt(expectedDispatchTimestampNs))
  ) {
    fail('runtime_visual_control_dispatch_timestamp_order_unproven');
  }
  if (
    !before.frame_timestamp_monotonic_ns
    || !after.frame_timestamp_monotonic_ns
    || BigInt(after.frame_timestamp_monotonic_ns)
      <= BigInt(before.frame_timestamp_monotonic_ns ?? '0')
  ) {
    fail('runtime_visual_control_capture_timestamp_order_unproven');
  }
  if (before.source_line_index === null || after.source_line_index === null
      || after.source_line_index <= before.source_line_index) {
    fail('runtime_visual_control_source_line_order_unproven');
  }
  if (before.width !== after.width || before.height !== after.height) {
    fail('runtime_visual_control_resolution_changed');
  }
  if (before.presentation_image_count !== after.presentation_image_count) {
    fail('runtime_visual_control_presentation_image_count_changed');
  }
  if (before.seed_policy_hash !== after.seed_policy_hash) {
    fail('runtime_visual_control_seed_policy_changed');
  }
  if (before.camera_state_hash !== after.camera_state_hash) {
    fail('runtime_visual_control_camera_state_changed');
  }
  for (const control of ['temporal_accumulation', 'taa', 'denoiser']) {
    if (!visualControlStateMatches(before, after, control)) {
      fail(`runtime_visual_control_${control}_uncontrolled`);
    }
  }

  const diagnosticFailedGates = compactStringList(failedGates);
  const evidenceRefs = compactStringList([
    before.observation_hash,
    after.observation_hash,
    before.source_line_hash,
    after.source_line_hash,
  ]);
  const diagnosticAccepted = diagnosticFailedGates.length === 0;
  const strictFailedGates = compactStringList([
    ...diagnosticFailedGates,
    'target_emitted_visual_control_state_not_independent_runtime_evidence',
  ]);
  const deterministicVisualMode = normalizeGpuHmrDeterministicVisualMode({});
  const deterministicVisualModeEvaluation = evaluateGpuHmrDeterministicVisualMode(
    deterministicVisualMode,
  );
  const pairCore = {
    schemaVersion: GPU_HMR_RUNTIME_VISUAL_CONTROL_PAIR_SCHEMA_VERSION,
    proofAuthority: 'target_emitted_visual_control_diagnostics_only_not_gpu_hmr_proof',
    accepted: false,
    diagnosticAccepted,
    supportValidated: diagnosticAccepted,
    strictAccepted: false,
    beforeObservationHash: before.observation_hash,
    afterObservationHash: after.observation_hash,
    expectedBeforeFrameHash,
    expectedAfterFrameHash,
    expectedWidth,
    expectedHeight,
    expectedProcessId,
    expectedDeviceIdentity,
    expectedRuntimeSession,
    expectedDispatchId,
    expectedDispatchLineIndex,
    expectedDispatchTimestampNs,
    evidenceRefs,
    failedGates: strictFailedGates,
    diagnosticFailedGates,
    strictFailedGates,
  };
  const pairHash = sha256Text(stableJson(pairCore));
  return {
    ...pairCore,
    schema_version: GPU_HMR_RUNTIME_VISUAL_CONTROL_PAIR_SCHEMA_VERSION,
    proof_authority: pairCore.proofAuthority,
    support_validated: diagnosticAccepted,
    strict_accepted: false,
    acceptedAsRuntimeVisualControlEvidence: false,
    accepted_as_runtime_visual_control_evidence: false,
    acceptedAsDiagnosticRuntimeVisualControlEvidence: diagnosticAccepted,
    accepted_as_diagnostic_runtime_visual_control_evidence: diagnosticAccepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    canSatisfyVisualControlProof: false,
    can_satisfy_visual_control_proof: false,
    before,
    after,
    deterministicVisualMode,
    deterministic_visual_mode: deterministicVisualMode,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    evidence_refs: evidenceRefs,
    failed_gates: strictFailedGates,
    diagnostic_failed_gates: diagnosticFailedGates,
    strict_failed_gates: strictFailedGates,
    pairHash,
    pair_hash: pairHash,
  };
}

export function normalizeGpuHmrDeterministicVisualMode(input = {}) {
  const mode = isObject(input) ? input : {};
  const afterDispatch = consensusBool(
    mode.output_observation_after_dispatch,
    mode.outputObservationAfterDispatch,
    mode.output_capture_after_dispatch,
    mode.outputCaptureAfterDispatch,
  );
  const orderingProven = consensusBool(
    mode.output_observation_ordering_proven,
    mode.outputObservationOrderingProven,
    mode.output_completion_observed,
    mode.outputCompletionObserved,
    mode.completion_boundary_proven,
    mode.completionBoundaryProven,
  );
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
    output_observation_after_dispatch: afterDispatch.value,
    output_observation_ordering_proven: orderingProven.value,
    alias_conflicts: compactStringList([
      afterDispatch.conflict ? 'output_observation_after_dispatch' : null,
      orderingProven.conflict ? 'output_observation_ordering_proven' : null,
    ]),
    convergence_window: convergenceWindow,
    non_visual_artifact_hashes: nonVisualArtifactHashes,
  };
}

export function evaluateGpuHmrDeterministicVisualMode(input = {}) {
  const mode = normalizeGpuHmrDeterministicVisualMode(input);
  const diagnosticFailedGates = [];
  const warnings = [];
  const convergenceDiagnosticsComplete = convergenceWindowAccepted(mode.convergence_window);

  if (mode.schema_version !== GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION) {
    addGate(diagnosticFailedGates, 'deterministic_visual_mode_schema_unsupported', {
      expected: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
      actual: mode.schema_version,
    });
  }
  if (mode.alias_conflicts.length > 0) {
    addGate(diagnosticFailedGates, 'output_observation_alias_conflict', {
      fields: mode.alias_conflicts,
    });
  }
  if (mode.output_observation_after_dispatch !== true) {
    addGate(diagnosticFailedGates, 'output_observation_after_dispatch_unproven');
  }
  if (mode.output_observation_ordering_proven !== true) {
    addGate(diagnosticFailedGates, 'output_observation_ordering_unproven');
  }
  const convergenceDeclared = mode.convergence_window.sample_start !== null
    || mode.convergence_window.sample_end !== null
    || mode.convergence_window.sample_count !== null
    || mode.convergence_window.samples.length > 0
    || mode.convergence_window.sample_hashes.length > 0
    || mode.convergence_window.observation_hashes.length > 0
    || mode.convergence_window.pre_dispatch_sample_hashes.length > 0
    || mode.convergence_window.post_dispatch_sample_hashes.length > 0
    || mode.convergence_window.artifact_hashes.length > 0
    || mode.convergence_window.metric !== null
    || mode.convergence_window.metric_value !== null
    || mode.convergence_window.metric_delta !== null
    || mode.convergence_window.convergence_proven !== null
    || mode.convergence_window.evidence_refs.length > 0;
  if (convergenceDeclared) {
    const window = mode.convergence_window;
    const requiredSamples = Math.max(2, finiteNumberOrNull(window.min_samples) ?? 2);
    const observedSamples = finiteNumberOrNull(window.sample_count) ?? 0;
    const sampleEvidenceHashes = compactStringList([
      ...window.sample_hashes,
      ...window.observation_hashes,
      ...window.pre_dispatch_sample_hashes,
      ...window.post_dispatch_sample_hashes,
    ]);
    const rawSampleEvidenceHashes = [
      ...window.raw_sample_hashes,
      ...window.raw_observation_hashes,
    ];
    const invalidSampleHashes = compactStringList(
      rawSampleEvidenceHashes.filter((hash) => !sha256ContentAddress(hash)),
    );
    const canonicalSampleHashes = rawSampleEvidenceHashes
      .map(sha256ContentAddress)
      .filter(Boolean);
    const duplicateSampleHashes = compactStringList(
      canonicalSampleHashes.filter(
        (hash, index) => canonicalSampleHashes.indexOf(hash) !== index,
      ),
    );
    const structuredPostDispatchHashes = compactStringList(
      window.samples
        .filter((sample) => sample.after_dispatch === true)
        .map((sample) => sha256ContentAddress(sample.sample_hash)),
    );
    const postDispatchHashes = compactStringList([
      ...window.post_dispatch_sample_hashes.map(sha256ContentAddress),
      ...structuredPostDispatchHashes,
    ]);
    const declaredSampleCount = finiteNumberOrNull(window.sample_count);
    const uniqueSampleCount = compactStringList(canonicalSampleHashes).length;
    if (
      window.sample_start === null
      || window.sample_end === null
      || window.sample_end < window.sample_start
    ) {
      addGate(diagnosticFailedGates, 'convergence_sample_range_invalid');
    }
    if (!window.metric?.value) {
      addGate(diagnosticFailedGates, 'convergence_metric_identifier_missing');
    }
    if (
      window.sample_hashes.length < requiredSamples
      && window.observation_hashes.length < requiredSamples
      && window.post_dispatch_sample_hashes.length < requiredSamples
    ) {
      addGate(diagnosticFailedGates, 'convergence_sample_evidence_missing', {
        requiredSamples,
        observedSamples,
      });
    }
    if (invalidSampleHashes.length > 0) {
      addGate(diagnosticFailedGates, 'convergence_sample_hash_invalid', {
        hashes: invalidSampleHashes.slice(0, 3),
      });
    }
    if (duplicateSampleHashes.length > 0) {
      addGate(diagnosticFailedGates, 'convergence_sample_hash_duplicate', {
        hashes: duplicateSampleHashes.slice(0, 3),
      });
    }
    if (declaredSampleCount !== null && declaredSampleCount !== uniqueSampleCount) {
      addGate(diagnosticFailedGates, 'convergence_sample_count_mismatch', {
        declaredSampleCount,
        uniqueSampleCount,
      });
    }
    if (postDispatchHashes.length < requiredSamples) {
      addGate(diagnosticFailedGates, 'convergence_post_dispatch_sample_evidence_missing', {
        requiredSamples,
        observedSamples: postDispatchHashes.length,
      });
    }
    if (window.samples.some((sample) => sample.after_dispatch !== true)) {
      addGate(diagnosticFailedGates, 'convergence_sample_ordering_unproven');
    }
    if (window.artifact_hashes.length > 0) {
      addGate(diagnosticFailedGates, 'convergence_artifact_hash_not_sample_evidence', {
        artifactHashCount: window.artifact_hashes.length,
      });
    }
    const leakedArtifactHashes = mode.non_visual_artifact_hashes
      .filter((hash) => sampleEvidenceHashes.includes(hash));
    if (leakedArtifactHashes.length > 0) {
      addGate(diagnosticFailedGates, 'convergence_sample_hash_matches_gpu_artifact_hash', {
        hashes: leakedArtifactHashes.slice(0, 3),
      });
    }
    if (
      window.metric_value === null
      && window.metric_delta === null
      && !window.samples.some((sample) => sample.metric_value !== null)
    ) {
      addGate(diagnosticFailedGates, 'convergence_metric_evidence_missing');
    }
    if (window.convergence_proven !== true) {
      addGate(diagnosticFailedGates, 'convergence_proof_missing');
    }
    if (window.evidence_refs.length === 0) {
      addGate(diagnosticFailedGates, 'convergence_evidence_refs_missing');
    }
  }

  const failedGates = [
    ...diagnosticFailedGates,
    { code: 'verifier_owned_output_observation_receipt_missing' },
  ];

  return {
    schemaVersion: GPU_HMR_DETERMINISTIC_VISUAL_MODE_SCHEMA_VERSION,
    proofAuthority: 'serialized_output_observation_diagnostics_only_not_gpu_hmr_proof',
    mode,
    accepted: false,
    diagnosticAccepted: diagnosticFailedGates.length === 0,
    supportValidated: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    proofMode: convergenceDiagnosticsComplete
      ? 'multi_sample_convergence_diagnostics'
      : 'single_observation_diagnostics',
    failedGates,
    diagnosticFailedGates,
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
  const binding = artifact?.runtimeVisualProofBinding
    ?? artifact?.runtime_visual_proof_binding
    ?? null;
  const bindingAccepted = binding
    && typeof binding === 'object'
    && binding.accepted === true
    && (
      binding.proofAuthority === 'proof_ledger_visual_oracle_hash_binding_not_image_only'
      || binding.proof_authority === 'proof_ledger_visual_oracle_hash_binding_not_image_only'
    );
  return visualEvidenceAcceptedAsImage(artifact)
    && !visualEvidenceIsSupplementalOnly(artifact)
    && (
      artifact?.acceptedAsRuntimeVisualProof === true
      || artifact?.accepted_as_runtime_visual_proof === true
      || artifact?.runtimeVisualProofAccepted === true
      || artifact?.runtime_visual_proof_accepted === true
    )
    && bindingAccepted;
}

function boundedVisualEvidenceLimit(value, hardLimit, label) {
  if (value === undefined || value === null) return hardLimit;
  if (!Number.isSafeInteger(value) || value < 1 || value > hardLimit) {
    throw new TypeError(`gpu_hmr_visual_evidence_${label}_invalid`);
  }
  return value;
}

async function boundedVisualEvidenceBytes(input, maxEncodedBytes) {
  if (Buffer.isBuffer(input)) {
    if (input.byteLength > maxEncodedBytes) {
      throw new RangeError('gpu_hmr_visual_evidence_encoded_byte_limit_exceeded');
    }
    return Buffer.from(input);
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > maxEncodedBytes) {
      throw new RangeError('gpu_hmr_visual_evidence_encoded_byte_limit_exceeded');
    }
    return Buffer.from(input);
  }
  if (typeof input !== 'string' || !input.trim()) {
    throw new TypeError('gpu_hmr_visual_evidence_input_invalid');
  }

  const handle = await open(input, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) {
      throw new TypeError('gpu_hmr_visual_evidence_input_not_file');
    }
    if (initial.size > maxEncodedBytes) {
      throw new RangeError('gpu_hmr_visual_evidence_encoded_byte_limit_exceeded');
    }
    const chunks = [];
    let byteLength = 0;
    while (true) {
      const remaining = maxEncodedBytes - byteLength;
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      byteLength += bytesRead;
      if (byteLength > maxEncodedBytes) {
        throw new RangeError('gpu_hmr_visual_evidence_encoded_byte_limit_exceeded');
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, byteLength);
  } finally {
    await handle.close();
  }
}

export async function analyzeGpuHmrImageEvidence(input, options = {}) {
  const maxEncodedBytes = boundedVisualEvidenceLimit(
    options.maxEncodedBytes,
    GPU_HMR_IMAGE_EVIDENCE_MAX_ENCODED_BYTES,
    'max_encoded_bytes',
  );
  const maxDecodedBytes = boundedVisualEvidenceLimit(
    options.maxDecodedBytes,
    GPU_HMR_IMAGE_EVIDENCE_MAX_DECODED_BYTES,
    'max_decoded_bytes',
  );
  const maxDimension = boundedVisualEvidenceLimit(
    options.maxDimension,
    GPU_HMR_IMAGE_EVIDENCE_MAX_DIMENSION,
    'max_dimension',
  );
  const maxPixels = boundedVisualEvidenceLimit(
    options.maxPixels,
    GPU_HMR_IMAGE_EVIDENCE_MAX_PIXELS,
    'max_pixels',
  );
  const bytes = await boundedVisualEvidenceBytes(input, maxEncodedBytes);
  const metadata = await sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: false,
    sequentialRead: true,
  }).metadata();
  const width = metadata.width;
  const height = metadata.height;
  const pages = metadata.pages ?? 1;
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || width > maxDimension
    || height > maxDimension
  ) {
    throw new RangeError('gpu_hmr_visual_evidence_dimension_limit_exceeded');
  }
  if (pages !== 1) {
    throw new RangeError('gpu_hmr_visual_evidence_multi_page_input_forbidden');
  }
  const encodedPixels = width * height;
  if (!Number.isSafeInteger(encodedPixels) || encodedPixels > maxPixels) {
    throw new RangeError('gpu_hmr_visual_evidence_decoded_pixel_limit_exceeded');
  }
  // Raw Sharp output can retain four channels for non-alpha color spaces.
  if (encodedPixels * 4 > maxDecodedBytes) {
    throw new RangeError('gpu_hmr_visual_evidence_decoded_byte_limit_exceeded');
  }
  const image = sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: maxPixels,
    sequentialRead: true,
  });
  const { data, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (data.byteLength > maxDecodedBytes) {
    throw new RangeError('gpu_hmr_visual_evidence_decoded_byte_limit_exceeded');
  }
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
  row.accepted_as_image_evidence = row.accepted_as_visual_evidence;
  row.accepted_as_runtime_visual_proof = visualEvidenceAcceptedAsRuntimeProof(row);
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
