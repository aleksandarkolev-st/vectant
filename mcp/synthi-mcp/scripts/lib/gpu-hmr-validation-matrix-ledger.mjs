import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { queryGpuHmrLedgerInvariants } from './gpu-hmr-proof-ledger.mjs';
import { classifyGpuHmrFissionProof } from './gpu-hmr-runtime-proof.mjs';
import { runtimeProofArtifactStrictGate } from './gpu-hmr-proof-strict-gates.mjs';
import { computeOracleArtifactsFromFiles } from './gpu-hmr-validation-proof-artifact.mjs';
import {
  evaluateGpuHmrDeterministicVisualMode,
  visualEvidenceIsSupplementalOnly,
} from './gpu-hmr-visual-evidence.mjs';
import {
  GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
  GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  computeAsyncVisualProof,
} from './gpu-hmr-visual-proof-worker.mjs';

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
  ['target_progression_evidence', 45],
  ['refusal_proven', 40],
  ['unproven', 0],
]);

const ACCEPTED_METRIC_SCOPES = new Set(['cold', 'warm', 'hot_delta_1', 'hot_delta_2']);
const ACCEPTED_CACHE_STATES = new Set(['clean', 'compiler_cache_warm', 'pipeline_cache_warm']);
const REQUIRED_FULL_TARGET_RUN_MODES = ['cold', 'hot_delta_1', 'hot_delta_2'];
const BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE = 'broad_library_agnostic';
const SCOPED_FULL_RUNTIME_ACCEPTANCE_SCOPES = new Set([
  'generated_rocm_hip_preview_visual',
  'hip_module_declared_compute_readback',
  'rocm_hip_declared_runtime_profile',
  'hiprt_declared_visual_profile',
  'webgpu_declared_compute_readback',
  'webgpu_declared_pipeline_visual',
]);
const VALIDATION_PROFILE_EVIDENCE_SCHEMA_VERSION =
  'synthi.gpu.hmr.validation_profile_evidence.v1';
const VALIDATION_PROFILE_EVIDENCE_SOURCES = new Set([
  'agent_split_fixture_runtime_visual_proof',
  'agent_split_profile_runtime_visual_proof',
  'agent_split_run_mode_visual_ledger_recomputed',
]);
const AGENT_SPLIT_SOURCE_FIRST_INGESTION_SCHEMA_VERSION =
  'synthi.gpu.hmr.agent_split_source_first_ingestion.v1';
const AGENT_SPLIT_SOURCE_FIRST_INGESTION_AUTHORITY =
  'source_first_ingestion_provenance_only_not_runtime_proof';
const ASYNC_VISUAL_CAS_SUPPORT_AUTHORITY =
  'async_visual_metrics_and_transport_only';
const REQUIRED_FULL_RUNTIME_LEDGER_RECORD_FIELDS = [
  ['schemaVersion', 'schema_version'],
  ['proofId', 'proof_id'],
  ['projectId', 'project_id'],
  ['editId', 'edit_id'],
  ['backend'],
  ['classification'],
  ['contractHash', 'contract_hash'],
  ['artifactBeforeHash', 'artifact_before_hash'],
  ['artifactAfterHash', 'artifact_after_hash'],
  ['loaderEvent', 'loader_event'],
  ['epochPublishEvent', 'epoch_publish_event'],
  ['dispatchEvent', 'dispatch_event'],
  ['outputEvent', 'output_event'],
  ['retirementEvent', 'retirement_event'],
  ['processIdentity', 'process_identity'],
  ['deviceIdentity', 'device_identity'],
  ['cpuHmrUsed', 'cpu_hmr_used'],
  ['fullRebuildUsed', 'full_rebuild_used'],
  ['processRestarted', 'process_restarted'],
  ['oracleArtifacts', 'oracle_artifacts'],
  ['timings'],
  ['modelProvenance', 'model_provenance'],
  ['evidenceRefs', 'evidence_refs'],
];
const GPU_HMR_GENERALITY_CLAIM_SCHEMA_VERSION = 'synthi.gpu_hmr.generality_claim.v1';
const REAL_ROCM_RUNTIME_CAPABILITY_PREFLIGHT_INPUT_SCHEMA_VERSION =
  'synthi.real_rocm.array_allocation_capability.v1';
const REAL_ROCM_RUNTIME_CAPABILITY_PREFLIGHT_FACET_SCHEMA_VERSION =
  'synthi.gpu_hmr.real_rocm_runtime_capability_preflight_facet.v1';
const REAL_ROCM_OUTPUT_ORACLE_RESOLUTION_SCHEMA_VERSION =
  'synthi.real_rocm.output_oracle_resolution.v1';
const REAL_ROCM_SIDECAR_RUNTIME_CONSISTENCY_SCHEMA_VERSION =
  'synthi.gpu_hmr.real_rocm_sidecar_runtime_consistency.v1';
const REAL_ROCM_SOURCE_DELTA_EXECUTION_SCHEMA_VERSION =
  'synthi.gpu_hmr.real_rocm_source_delta_execution.v1';
const REAL_ROCM_RUNTIME_STAGE_OBLIGATIONS_SCHEMA_VERSION =
  'synthi.gpu_hmr.real_rocm_runtime_stage_obligations.v1';
const REAL_ROCM_APP_HOOK_MATERIALIZATION_SCHEMA_VERSION =
  'synthi.gpu_hmr.real_rocm_app_hook_materialization.v1';
const REAL_ROCM_PROOF_SCHEDULING_SCHEMA_VERSION =
  'synthi.gpu_hmr.real_rocm_proof_scheduling.v1';
const VALIDATION_BLOCKER_SCHEMA_VERSION =
  'synthi.gpu_hmr.validation_blocker.v1';
const REAL_ROCM_OUTPUT_ORACLE_SELECTED_SOURCES = new Set([
  'profile_runtime_profile',
  'source_derived_profile',
]);
const TARGET_PROGRESSION_PHASES = new Set([
  'small-oracle',
  'partial-reload',
  'original-host-path',
  'final-acceptance',
]);
const TARGET_PROGRESSION_PHASE_ALIASES = new Map([
  ['small', 'small-oracle'],
  ['small-target', 'small-oracle'],
  ['small-kernel', 'small-oracle'],
  ['small-non-final', 'small-oracle'],
  ['small-non-final-oracle', 'small-oracle'],
  ['deterministic-oracle', 'small-oracle'],
  ['oracle', 'small-oracle'],
  ['partial', 'partial-reload'],
  ['partial-artifact', 'partial-reload'],
  ['partial-artifact-reload', 'partial-reload'],
  ['source-include', 'partial-reload'],
  ['source-include-reload', 'partial-reload'],
  ['original-host', 'original-host-path'],
  ['host-path', 'original-host-path'],
  ['host-attachment', 'original-host-path'],
  ['final', 'final-acceptance'],
  ['acceptance', 'final-acceptance'],
  ['final-target', 'final-acceptance'],
]);
const FINAL_ACCEPTANCE_PRIOR_TARGET_PROGRESSION_PHASES = Object.freeze([
  'small-oracle',
  'partial-reload',
  'original-host-path',
]);
const SCOPED_GENERALITY_UNSUPPORTED_WITHOUT_EVIDENCE = [
  'arbitrary_library_without_matching_acceptance_contract',
  'arbitrary_target_without_same_process_loader_epoch_dispatch_and_oracle_proof',
  'different_backend_contract_without_recomputed_proof_ledger',
  'different_runtime_environment_without_runtime_capability_preflight',
];
const REAL_ROCM_APP_HOOK_REQUIRED_STAGES = Object.freeze([
  'artifact_transport',
  'epoch_publication',
  'dispatch_trace',
  'host_identity',
  'output_oracle',
]);
const RUNTIME_VISUAL_ORACLE_EVIDENCE_REQUIREMENTS = Object.freeze({
  required: true,
  requireDeclaredHashes: true,
  requireDiff: true,
  allowSingleFrameProof: false,
});

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

function sha256BufferHash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function proofIdFor(prefix, value) {
  return `${prefix}:sha256:${sha256Hex(stableJson(value))}`;
}

function rowIdSeed(row = {}) {
  const seed = { ...row };
  delete seed.rowId;
  delete seed.row_id;
  delete seed.matrixKey;
  delete seed.matrix_key;
  delete seed.attemptKey;
  delete seed.attempt_key;
  return seed;
}

function rowIdFor(row = {}) {
  return proofIdFor('gpu-validation-matrix-row', rowIdSeed(row));
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

function firstEpochText(...values) {
  for (const value of values) {
    const normalized = firstText(value);
    if (normalized) return normalized;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return String(value);
    }
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

function stringEvidenceList(values) {
  return (Array.isArray(values) ? values : [])
    .map(text)
    .filter(Boolean);
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

function hasOwnAny(object, names) {
  return names.some((name) => Object.prototype.hasOwnProperty.call(object, name));
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

function pathInside(childPath, parentPath) {
  if (!childPath || !parentPath) return false;
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveEvidencePath(value, repoRoot, baseDir = repoRoot) {
  const normalized = normalizeMaybeWindowsPath(value);
  if (!normalized) return null;
  const roots = [repoRoot, baseDir]
    .map((root) => (root ? path.resolve(root) : null))
    .filter(Boolean);
  const isAllowed = (candidate) => roots.some((root) => pathInside(candidate, root));
  if (path.isAbsolute(normalized)) {
    const resolved = path.resolve(normalized);
    return isAllowed(resolved) ? resolved : null;
  }
  const repoResolved = path.resolve(repoRoot, normalized);
  if (isAllowed(repoResolved)) return repoResolved;
  const baseResolved = path.resolve(baseDir, normalized);
  return isAllowed(baseResolved) ? baseResolved : null;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256Hash(filePath) {
  try {
    return sha256BufferHash(await fs.readFile(filePath));
  } catch {
    return null;
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
    const fileBuffer = await fs.readFile(filePath);
    const fileHash = sha256BufferHash(fileBuffer);
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
        sha256: fileHash,
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
      sha256: null,
      pngSignatureValid: false,
      decoded: false,
      decodeError: 'file_not_found_or_unreadable',
      format: null,
      width: null,
      height: null,
    };
  }
}

function normalizeSha256(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^sha256:[a-f0-9]{64}$/i.test(raw)) return raw.toLowerCase();
  if (/^[a-f0-9]{64}$/i.test(raw)) return `sha256:${raw.toLowerCase()}`;
  return raw;
}

function inferredVisualArtifactRole(value, index, count) {
  const raw = text(value) ?? '';
  const lower = raw.toLowerCase();
  if (lower.includes('before') || lower.includes('baseline')) return 'before';
  if (lower.includes('after') || lower.includes('changed')) return 'after';
  if (lower.includes('diff') || lower.includes('delta')) return 'diff';
  if (count === 3 && index === 0) return 'before';
  if (count === 3 && index === 1) return 'after';
  if (count === 3 && index === 2) return 'diff';
  return 'artifact';
}

function visualArtifactRole(value, sourcePath, index, count) {
  const role = text(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (['before', 'baseline'].includes(role)) return 'before';
  if (['after', 'changed'].includes(role)) return 'after';
  if (['diff', 'delta'].includes(role)) return 'diff';
  return inferredVisualArtifactRole(sourcePath, index, count);
}

function visualArtifactHashForRole(object, role) {
  return normalizeSha256(firstText(
    object.expectedHash,
    object.expected_hash,
    object.contentHash,
    object.content_hash,
    object.sha256,
    object.imageSha256,
    object.image_sha256,
    object.hash,
    role === 'before' ? object.before_image_hash : null,
    role === 'before' ? object.beforeImageHash : null,
    role === 'after' ? object.after_image_hash : null,
    role === 'after' ? object.afterImageHash : null,
    role === 'diff' ? object.diff_image_hash : null,
    role === 'diff' ? object.diffImageHash : null,
  ));
}

function visualArtifactEntries(input) {
  if (Array.isArray(input)) {
    return input.flatMap((value, index) => {
      if (typeof value === 'string') {
        return [{
          role: inferredVisualArtifactRole(value, index, input.length),
          sourcePath: value,
          expectedHash: null,
        }];
      }
      if (!isObject(value)) return [];
      const sourcePath = firstText(
        value.path,
        value.sourcePath,
        value.source_path,
        value.localPath,
        value.local_path,
        value.absolutePath,
        value.absolute_path,
        value.filePath,
        value.file_path,
        value.file,
        value.uri,
      );
      if (!sourcePath) return visualArtifactEntries(value);
      const role = visualArtifactRole(value.role ?? value.artifactRole ?? value.artifact_role, sourcePath, index, input.length);
      return [{
        role,
        sourcePath,
        expectedHash: visualArtifactHashForRole(value, role),
      }];
    });
  }
  const object = compactObject(input);
  if (Object.keys(object).length === 0) return [];
  const entries = [];
  const directSourcePath = firstText(
    object.path,
    object.sourcePath,
    object.source_path,
    object.localPath,
    object.local_path,
    object.absolutePath,
    object.absolute_path,
    object.filePath,
    object.file_path,
    object.file,
    object.uri,
  );
  if (directSourcePath) {
    const role = visualArtifactRole(object.role ?? object.artifactRole ?? object.artifact_role, directSourcePath, 0, 1);
    entries.push({
      role,
      sourcePath: directSourcePath,
      expectedHash: visualArtifactHashForRole(object, role),
    });
  }
  const push = (role, pathValues, hashValues = []) => {
    const sourcePath = firstText(...pathValues);
    if (!sourcePath) return;
    entries.push({
      role,
      sourcePath,
      expectedHash: normalizeSha256(firstText(...hashValues)),
    });
  };
  push('before', [object.before_image, object.beforeImage], [object.before_image_hash, object.beforeImageHash]);
  push('after', [object.after_image, object.afterImage], [object.after_image_hash, object.afterImageHash]);
  push('diff', [object.diff_image, object.diffImage], [object.diff_image_hash, object.diffImageHash]);
  push('before', [object.baseline_image, object.baselineImage, object.baselineCapturePath, object.baseline_capture_path]);
  push('after', [object.changed_image, object.changedImage, object.changedCapturePath, object.changed_capture_path]);
  push('artifact', [object.rendered_card_png, object.renderedCardPng]);
  push('artifact', [object.diagnostic_screenshot, object.diagnosticScreenshot]);
  return entries;
}

function visualArtifactEvidenceOptions(required) {
  if (isObject(required)) {
    return {
      required: firstBool(required.required, required.visualRequired, required.visual_required) === true,
      requireDeclaredHashes:
        firstBool(
          required.requireDeclaredHashes,
          required.require_declared_hashes,
          required.requireContentHashes,
          required.require_content_hashes,
        ) === true,
      requireDiff:
        firstBool(
          required.requireDiff,
          required.require_diff,
          required.requireDiffImage,
          required.require_diff_image,
        ) === true,
      allowSingleFrameProof:
        firstBool(
          required.allowSingleFrameProof,
          required.allow_single_frame_proof,
          required.allowSingleFrameVisualProof,
          required.allow_single_frame_visual_proof,
        ) === true,
    };
  }
  return {
    required: required === true,
    requireDeclaredHashes: false,
    requireDiff: false,
    allowSingleFrameProof: false,
  };
}

function runtimeVisualOracleEvidenceRequirements({ allowSingleFrameProof = false } = {}) {
  return {
    ...RUNTIME_VISUAL_ORACLE_EVIDENCE_REQUIREMENTS,
    requireDeclaredHashes: allowSingleFrameProof ? false : true,
    requireDiff: allowSingleFrameProof ? false : true,
    allowSingleFrameProof,
  };
}

function visualThresholdRequirements(metrics = {}) {
  const raw = compactObject(metrics);
  const thresholds = compactObject(
    raw.visualProofThresholds
    ?? raw.visual_proof_thresholds
    ?? raw.visualThresholds
    ?? raw.visual_thresholds
    ?? raw.thresholds,
  );
  const minChangedRatio = finiteNumber(
    thresholds.minChangedRatio
    ?? thresholds.min_changed_ratio
    ?? thresholds.minChangedPixelRatio
    ?? thresholds.min_changed_pixel_ratio
    ?? thresholds.minChangedPixelRatioThreshold4
    ?? thresholds.min_changed_pixel_ratio_threshold4
    ?? raw.minChangedRatio
    ?? raw.min_changed_ratio
    ?? raw.minChangedPixelRatio
    ?? raw.min_changed_pixel_ratio,
  );
  const minMeanAbsDelta8bit = finiteNumber(
    thresholds.minMeanAbs
    ?? thresholds.min_mean_abs
    ?? thresholds.minMeanAbsDelta8bit
    ?? thresholds.min_mean_abs_delta_8bit
    ?? thresholds.minMeanAbsDelta
    ?? thresholds.min_mean_abs_delta
    ?? raw.minMeanAbs
    ?? raw.min_mean_abs
    ?? raw.minMeanAbsDelta8bit
    ?? raw.min_mean_abs_delta_8bit,
  );
  return {
    present: minChangedRatio !== null || minMeanAbsDelta8bit !== null,
    minChangedRatio,
    min_changed_ratio: minChangedRatio,
    minMeanAbsDelta8bit,
    min_mean_abs_delta_8bit: minMeanAbsDelta8bit,
  };
}

function visualThresholdValidationForPair(visualPair = {}, thresholds = {}) {
  if (thresholds.present !== true) {
    return {
      present: false,
      accepted: true,
      failedGates: [],
      failed_gates: [],
    };
  }
  const changedPixelRatio = finiteNumber(
    visualPair.changedPixelRatio ?? visualPair.changed_pixel_ratio,
  );
  const meanAbsDelta8bit = finiteNumber(
    visualPair.meanAbsDelta8bit ?? visualPair.mean_abs_delta_8bit,
  );
  const failedGates = compactStringList([
    visualPair.accepted === true ? null : 'visual_threshold_pair_recompute_not_accepted',
    thresholds.minChangedRatio === null || (
      changedPixelRatio !== null && changedPixelRatio >= thresholds.minChangedRatio
    )
      ? null
      : 'visual_changed_pixel_ratio_below_declared_threshold',
    thresholds.minMeanAbsDelta8bit === null || (
      meanAbsDelta8bit !== null && meanAbsDelta8bit >= thresholds.minMeanAbsDelta8bit
    )
      ? null
      : 'visual_mean_abs_delta_below_declared_threshold',
  ]);
  return {
    present: true,
    accepted: failedGates.length === 0,
    source: 'matrix_recomputed_png_pixels_declared_thresholds',
    thresholds,
    changedPixelRatio,
    changed_pixel_ratio: changedPixelRatio,
    meanAbsDelta8bit,
    mean_abs_delta_8bit: meanAbsDelta8bit,
    failedGates,
    failed_gates: failedGates,
  };
}

function preferredVisualImage(images, role) {
  return images.find((item) => item.role === role && item.exists && item.decoded)
    ?? images.find((item) => item.role === role);
}

function visualWorkerAllowedRoots(images) {
  return [...new Set((Array.isArray(images) ? images : [])
    .map((item) => item?.absolutePath ?? item?.path)
    .filter(Boolean)
    .map((filePath) => path.dirname(path.resolve(filePath))))];
}

function visualWorkerTimeoutMs() {
  const value = Number(process.env.SYNTHI_GPU_HMR_VISUAL_WORKER_TIMEOUT_MS ?? 30000);
  return Number.isSafeInteger(value) && value > 0 ? value : 30000;
}

function summarizeAsyncVisualProof(proof) {
  if (!isObject(proof)) return null;
  const tileEvidence = isObject(proof.tileEvidence ?? proof.tile_evidence)
    ? proof.tileEvidence ?? proof.tile_evidence
    : null;
  const roiEvidence = isObject(proof.roiEvidence ?? proof.roi_evidence)
    ? proof.roiEvidence ?? proof.roi_evidence
    : null;
  const inputHashes = isObject(proof.inputHashes ?? proof.input_hashes)
    ? proof.inputHashes ?? proof.input_hashes
    : {};
  const metrics = isObject(proof.metrics) ? proof.metrics : {};
  const dimensions = isObject(proof.dimensions) ? proof.dimensions : {};
  const incremental = isObject(proof.incremental) ? proof.incremental : {};
  const worker = isObject(proof.worker) ? proof.worker : {};
  const stableMetrics = {
    changedRatio: finiteNumber(metrics.changedRatio ?? metrics.changed_ratio),
    changed_ratio: finiteNumber(metrics.changedRatio ?? metrics.changed_ratio),
    meanAbs: finiteNumber(metrics.meanAbs ?? metrics.mean_abs),
    mean_abs: finiteNumber(metrics.meanAbs ?? metrics.mean_abs),
    meanAbsDelta8bit: finiteNumber(metrics.meanAbsDelta8bit ?? metrics.mean_abs_delta_8bit),
    mean_abs_delta_8bit: finiteNumber(metrics.meanAbsDelta8bit ?? metrics.mean_abs_delta_8bit),
    changedPixels: finiteNumber(metrics.changedPixels ?? metrics.changed_pixels),
    changed_pixels: finiteNumber(metrics.changedPixels ?? metrics.changed_pixels),
    changedPixelsThreshold4: finiteNumber(metrics.changedPixelsThreshold4 ?? metrics.changed_pixels_threshold_4),
    changed_pixels_threshold_4: finiteNumber(metrics.changedPixelsThreshold4 ?? metrics.changed_pixels_threshold_4),
    changedPixelRatioThreshold4:
      finiteNumber(metrics.changedPixelRatioThreshold4 ?? metrics.changed_pixel_ratio_threshold_4),
    changed_pixel_ratio_threshold_4:
      finiteNumber(metrics.changedPixelRatioThreshold4 ?? metrics.changed_pixel_ratio_threshold_4),
    visiblePixelCount: finiteNumber(metrics.visiblePixelCount ?? metrics.visible_pixel_count),
    visible_pixel_count: finiteNumber(metrics.visiblePixelCount ?? metrics.visible_pixel_count),
    visiblePixelRatio: finiteNumber(metrics.visiblePixelRatio ?? metrics.visible_pixel_ratio),
    visible_pixel_ratio: finiteNumber(metrics.visiblePixelRatio ?? metrics.visible_pixel_ratio),
    meanLuma8bit: finiteNumber(metrics.meanLuma8bit ?? metrics.mean_luma_8bit),
    mean_luma_8bit: finiteNumber(metrics.meanLuma8bit ?? metrics.mean_luma_8bit),
    pixelCount: finiteNumber(metrics.pixelCount ?? metrics.pixel_count),
    pixel_count: finiteNumber(metrics.pixelCount ?? metrics.pixel_count),
  };
  const summary = {
    schemaVersion: proof.schemaVersion ?? proof.schema_version ?? GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    schema_version: proof.schemaVersion ?? proof.schema_version ?? GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    eventType: proof.eventType ?? proof.event_type ?? 'proof_ready',
    event_type: proof.eventType ?? proof.event_type ?? 'proof_ready',
    accepted: proof.accepted === true,
    acceptedAsAsyncVisualMetrics: proof.acceptedAsAsyncVisualMetrics === true,
    accepted_as_async_visual_metrics: proof.acceptedAsAsyncVisualMetrics === true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
    proof_authority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
    worker: {
      kind: text(worker.kind) || 'node_worker_threads',
      identitySchemaVersion:
        text(worker.identitySchemaVersion ?? worker.identity_schema_version) || null,
      identity_schema_version:
        text(worker.identitySchemaVersion ?? worker.identity_schema_version) || null,
      executorIdentity:
        text(worker.executorIdentity ?? worker.executor_identity) || null,
      executor_identity:
        text(worker.executorIdentity ?? worker.executor_identity) || null,
      executableHash:
        text(worker.executableHash ?? worker.executable_hash) || null,
      executable_hash:
        text(worker.executableHash ?? worker.executable_hash) || null,
      executableManifestHash:
        text(worker.executableManifestHash ?? worker.executable_manifest_hash) || null,
      executable_manifest_hash:
        text(worker.executableManifestHash ?? worker.executable_manifest_hash) || null,
      executableManifestSchemaVersion:
        text(worker.executableManifestSchemaVersion ?? worker.executable_manifest_schema_version) || null,
      executable_manifest_schema_version:
        text(worker.executableManifestSchemaVersion ?? worker.executable_manifest_schema_version) || null,
      executableModuleCount:
        Number.isSafeInteger(Number(worker.executableModuleCount ?? worker.executable_module_count))
          ? Number(worker.executableModuleCount ?? worker.executable_module_count)
          : null,
      executable_module_count:
        Number.isSafeInteger(Number(worker.executableModuleCount ?? worker.executable_module_count))
          ? Number(worker.executableModuleCount ?? worker.executable_module_count)
          : null,
      offMainThread: worker.offMainThread === true,
      off_main_thread: worker.offMainThread === true,
      failedBeforeWorkerCompletion: worker.failedBeforeWorkerCompletion === true,
      failed_before_worker_completion: worker.failedBeforeWorkerCompletion === true,
    },
    incremental: {
      roiEvaluated: incremental.roiEvaluated === true,
      roi_evaluated: incremental.roiEvaluated === true,
      tileHashing: incremental.tileHashing === true,
      tile_hashing: incremental.tileHashing === true,
      fullFrameDiffComputed: incremental.fullFrameDiffComputed === true,
      full_frame_diff_computed: incremental.fullFrameDiffComputed === true,
      deepDiffSkipped: incremental.deepDiffSkipped === true,
      deep_diff_skipped: incremental.deepDiffSkipped === true,
      skipReason: text(incremental.skipReason ?? incremental.skip_reason) || null,
      skip_reason: text(incremental.skipReason ?? incremental.skip_reason) || null,
    },
    dimensions: {
      width: finiteNumber(dimensions.width),
      height: finiteNumber(dimensions.height),
      channels: finiteNumber(dimensions.channels),
    },
    inputHashes: {
      beforeEncodedHash: text(inputHashes.beforeEncodedHash ?? inputHashes.before_encoded_hash) || null,
      before_encoded_hash: text(inputHashes.beforeEncodedHash ?? inputHashes.before_encoded_hash) || null,
      afterEncodedHash: text(inputHashes.afterEncodedHash ?? inputHashes.after_encoded_hash) || null,
      after_encoded_hash: text(inputHashes.afterEncodedHash ?? inputHashes.after_encoded_hash) || null,
      beforeRawHash: text(inputHashes.beforeRawHash ?? inputHashes.before_raw_hash) || null,
      before_raw_hash: text(inputHashes.beforeRawHash ?? inputHashes.before_raw_hash) || null,
      afterRawHash: text(inputHashes.afterRawHash ?? inputHashes.after_raw_hash) || null,
      after_raw_hash: text(inputHashes.afterRawHash ?? inputHashes.after_raw_hash) || null,
    },
    input_hashes: {
      before_encoded_hash: text(inputHashes.beforeEncodedHash ?? inputHashes.before_encoded_hash) || null,
      after_encoded_hash: text(inputHashes.afterEncodedHash ?? inputHashes.after_encoded_hash) || null,
      before_raw_hash: text(inputHashes.beforeRawHash ?? inputHashes.before_raw_hash) || null,
      after_raw_hash: text(inputHashes.afterRawHash ?? inputHashes.after_raw_hash) || null,
    },
    metrics: stableMetrics,
    roiEvidence: roiEvidence
      ? {
          accepted: roiEvidence.accepted === true,
          changed: roiEvidence.changed === true,
          beforeHash: text(roiEvidence.beforeHash ?? roiEvidence.before_hash) || null,
          before_hash: text(roiEvidence.beforeHash ?? roiEvidence.before_hash) || null,
          afterHash: text(roiEvidence.afterHash ?? roiEvidence.after_hash) || null,
          after_hash: text(roiEvidence.afterHash ?? roiEvidence.after_hash) || null,
        }
      : null,
    roi_evidence: roiEvidence
      ? {
          accepted: roiEvidence.accepted === true,
          changed: roiEvidence.changed === true,
          before_hash: text(roiEvidence.beforeHash ?? roiEvidence.before_hash) || null,
          after_hash: text(roiEvidence.afterHash ?? roiEvidence.after_hash) || null,
        }
      : null,
    tileEvidence: tileEvidence
      ? {
          accepted: tileEvidence.accepted === true,
          tileSize: tileEvidence.tileSize ?? tileEvidence.tile_size ?? null,
          tile_size: tileEvidence.tileSize ?? tileEvidence.tile_size ?? null,
          tileCount: tileEvidence.tileCount ?? tileEvidence.tile_count ?? null,
          tile_count: tileEvidence.tileCount ?? tileEvidence.tile_count ?? null,
          changedTileCount: tileEvidence.changedTileCount ?? tileEvidence.changed_tile_count ?? null,
          changed_tile_count: tileEvidence.changedTileCount ?? tileEvidence.changed_tile_count ?? null,
          changedTileRatio: tileEvidence.changedTileRatio ?? tileEvidence.changed_tile_ratio ?? null,
          changed_tile_ratio: tileEvidence.changedTileRatio ?? tileEvidence.changed_tile_ratio ?? null,
        }
      : null,
    tile_evidence: tileEvidence
      ? {
          accepted: tileEvidence.accepted === true,
          tile_size: tileEvidence.tileSize ?? tileEvidence.tile_size ?? null,
          tile_count: tileEvidence.tileCount ?? tileEvidence.tile_count ?? null,
          changed_tile_count: tileEvidence.changedTileCount ?? tileEvidence.changed_tile_count ?? null,
          changed_tile_ratio: tileEvidence.changedTileRatio ?? tileEvidence.changed_tile_ratio ?? null,
        }
      : null,
    reasons: Array.isArray(proof.reasons) ? proof.reasons : [],
    gaps: Array.isArray(proof.gaps) ? proof.gaps : [],
  };
  const replayHash = `sha256:${sha256Hex(stableJson(summary))}`;
  return {
    ...summary,
    asyncVisualMetricsHash: replayHash,
    async_visual_metrics_hash: replayHash,
  };
}

async function asyncVisualMetricsForPair(before, after, request = {}) {
  if (!before?.absolutePath || !after?.absolutePath) return null;
  try {
    const proof = await computeAsyncVisualProof({
      before: { path: before.absolutePath },
      after: { path: after.absolutePath },
      includeAlpha: true,
      tileSize: 128,
      ...request,
    }, {
      allowedRoots: visualWorkerAllowedRoots([before, after]),
      timeoutMs: visualWorkerTimeoutMs(),
    });
    return summarizeAsyncVisualProof(proof);
  } catch (error) {
    return summarizeAsyncVisualProof({
      schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
      eventType: 'proof_ready',
      accepted: false,
      acceptedAsAsyncVisualMetrics: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
      worker: {
        kind: 'node_worker_threads',
        offMainThread: true,
        failedBeforeWorkerCompletion: true,
      },
      incremental: {
        roiEvaluated: false,
        tileHashing: false,
        fullFrameDiffComputed: false,
        deepDiffSkipped: false,
        skipReason: null,
      },
      reasons: ['async_visual_metrics_worker_failed'],
      gaps: ['async_visual_metrics_worker_failed'],
      details: { message: error?.message ? String(error.message) : String(error) },
    });
  }
}

async function recomputeVisualPairEvidence(images) {
  const before = preferredVisualImage(images, 'before');
  const after = preferredVisualImage(images, 'after');
  const diff = preferredVisualImage(images, 'diff');
  if (!before || !after) {
    return {
      present: false,
      accepted: false,
      source: 'matrix_recomputed_png_pixels',
      failedGates: [{ code: 'visual_pair_before_after_missing' }],
    };
  }
  if (!before.decoded || !after.decoded) {
    return {
      present: true,
      accepted: false,
      source: 'matrix_recomputed_png_pixels',
      failedGates: [{ code: 'visual_pair_before_after_not_decoded' }],
    };
  }
  try {
    const asyncVisualMetrics = await asyncVisualMetricsForPair(before, after);
    if (before.width !== after.width || before.height !== after.height) {
      return {
        present: true,
        accepted: false,
        source: 'matrix_recomputed_png_pixels',
        asyncVisualMetrics,
        async_visual_metrics: asyncVisualMetrics,
        failedGates: [{ code: 'visual_pair_dimension_mismatch' }],
      };
    }
    const beforeFrame = await sharp(before.absolutePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const afterFrame = await sharp(after.absolutePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (
      beforeFrame.info.width !== afterFrame.info.width
      || beforeFrame.info.height !== afterFrame.info.height
      || beforeFrame.info.channels !== afterFrame.info.channels
    ) {
      return {
        present: true,
        accepted: false,
        source: 'matrix_recomputed_png_pixels',
        asyncVisualMetrics,
        async_visual_metrics: asyncVisualMetrics,
        failedGates: [{ code: 'visual_pair_dimension_mismatch' }],
      };
    }
    const pixelCount = beforeFrame.info.width * beforeFrame.info.height;
    let changedPixelsThreshold4 = 0;
    let totalAbsDelta = 0;
    let visiblePixelCount = 0;
    for (let i = 0; i < beforeFrame.data.length; i += 4) {
      const dr = Math.abs(beforeFrame.data[i] - afterFrame.data[i]);
      const dg = Math.abs(beforeFrame.data[i + 1] - afterFrame.data[i + 1]);
      const db = Math.abs(beforeFrame.data[i + 2] - afterFrame.data[i + 2]);
      const da = Math.abs(beforeFrame.data[i + 3] - afterFrame.data[i + 3]);
      if (Math.max(dr, dg, db) > 4) changedPixelsThreshold4 += 1;
      if (
        afterFrame.data[i + 3] > 0
        && (afterFrame.data[i] > 4 || afterFrame.data[i + 1] > 4 || afterFrame.data[i + 2] > 4)
      ) {
        visiblePixelCount += 1;
      }
      totalAbsDelta += dr + dg + db + da;
    }
    const changedPixelRatio = pixelCount > 0 ? changedPixelsThreshold4 / pixelCount : null;
    const meanAbsDelta8bit = pixelCount > 0 ? totalAbsDelta / (pixelCount * 4) : null;
    let diffVisiblePixelCount = null;
    if (diff?.decoded) {
      const diffFrame = await recomputeSingleVisualFrameEvidence([diff], {
        includeAsyncVisualMetrics: false,
      });
      diffVisiblePixelCount = finiteNumber(diffFrame.visiblePixelCount ?? diffFrame.visible_pixel_count);
    }
    const accepted =
      Number(changedPixelRatio) > 0
      && Number(meanAbsDelta8bit) > 0
      && visiblePixelCount > 0
      && (diff ? Number(diffVisiblePixelCount) > 0 : true);
    return {
      present: true,
      accepted,
      source: 'matrix_recomputed_png_pixels',
      recomputeEngine: 'matrix_local_sharp_rgba',
      recompute_engine: 'matrix_local_sharp_rgba',
      asyncVisualMetrics,
      async_visual_metrics: asyncVisualMetrics,
      width: beforeFrame.info.width,
      height: beforeFrame.info.height,
      changedPixelsThreshold4,
      changedPixelRatio,
      changed_pixel_ratio: changedPixelRatio,
      meanAbsDelta8bit,
      mean_abs_delta_8bit: meanAbsDelta8bit,
      visiblePixelCount,
      visible_pixel_count: visiblePixelCount,
      diffVisiblePixelCount,
      diff_visible_pixel_count: diffVisiblePixelCount,
      failedGates: compactStringList([
        Number(changedPixelRatio) > 0 ? null : 'visual_pair_zero_pixel_delta',
        Number(meanAbsDelta8bit) > 0 ? null : 'visual_pair_zero_mean_delta',
        visiblePixelCount > 0 ? null : 'visual_pair_blank_after_frame',
        diff && !(Number(diffVisiblePixelCount) > 0) ? 'visual_diff_frame_blank' : null,
      ]).map((code) => ({ code })),
    };
  } catch (error) {
    const asyncVisualMetrics = await asyncVisualMetricsForPair(before, after);
    return {
      present: true,
      accepted: false,
      source: 'matrix_recomputed_png_pixels',
      asyncVisualMetrics,
      async_visual_metrics: asyncVisualMetrics,
      failedGates: [{
        code: 'visual_pair_pixel_recompute_error',
        message: error?.message ? String(error.message) : String(error),
      }],
    };
  }
}

async function recomputeSingleVisualFrameEvidence(images, options = {}) {
  const image =
    preferredVisualImage(images, 'after')
    ?? preferredVisualImage(images, 'before')
    ?? images.find((item) => item.exists && item.decoded)
    ?? images[0];
  if (!image) {
    return {
      present: false,
      accepted: false,
      source: 'matrix_recomputed_single_png_pixels',
      failedGates: [{ code: 'visual_single_frame_missing' }],
    };
  }
  if (!image.decoded) {
    return {
      present: true,
      accepted: false,
      source: 'matrix_recomputed_single_png_pixels',
      failedGates: [{ code: 'visual_single_frame_not_decoded' }],
    };
  }
  try {
    const includeAsyncVisualMetrics = options.includeAsyncVisualMetrics !== false;
    const asyncVisualMetrics = includeAsyncVisualMetrics
      ? await asyncVisualMetricsForPair(image, image, { tileHashing: false })
      : null;
    const frame = await sharp(image.absolutePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixelCount = frame.info.width * frame.info.height;
    let visiblePixelCount = 0;
    let lumaSum = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      const r = frame.data[i];
      const g = frame.data[i + 1];
      const b = frame.data[i + 2];
      const a = frame.data[i + 3];
      if (a > 0 && (r > 4 || g > 4 || b > 4)) visiblePixelCount += 1;
      lumaSum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const visiblePixelRatio = pixelCount > 0 ? visiblePixelCount / pixelCount : null;
    const meanLuma8bit = pixelCount > 0 ? lumaSum / pixelCount : null;
    const accepted = pixelCount > 0 && visiblePixelCount > 0;
    return {
      present: true,
      accepted,
      source: 'matrix_recomputed_single_png_pixels',
      recomputeEngine: 'matrix_local_sharp_rgba',
      recompute_engine: 'matrix_local_sharp_rgba',
      asyncVisualMetrics,
      async_visual_metrics: asyncVisualMetrics,
      imageRole: image.role,
      image_role: image.role,
      width: frame.info.width,
      height: frame.info.height,
      visiblePixelCount,
      visible_pixel_count: visiblePixelCount,
      visiblePixelRatio,
      visible_pixel_ratio: visiblePixelRatio,
      meanLuma8bit,
      mean_luma_8bit: meanLuma8bit,
      failedGates: compactStringList([
        pixelCount > 0 ? null : 'visual_single_frame_empty',
        visiblePixelCount > 0 ? null : 'visual_single_frame_blank',
      ]).map((code) => ({ code })),
    };
  } catch (error) {
    return {
      present: true,
      accepted: false,
      source: 'matrix_recomputed_single_png_pixels',
      failedGates: [{
        code: 'visual_single_frame_pixel_recompute_error',
        message: error?.message ? String(error.message) : String(error),
      }],
    };
  }
}

async function visualArtifactEvidence(paths, repoRoot, baseDir, metrics = {}, required = false) {
  const options = visualArtifactEvidenceOptions(required);
  const entries = visualArtifactEntries(paths);
  const resolvedEntries = entries
    .map((entry) => ({
      ...entry,
      resolvedPath: resolveEvidencePath(entry.sourcePath, repoRoot, baseDir),
    }));
  const evidence = [];
  for (const entry of resolvedEntries) {
    const fileEvidence = entry.resolvedPath
      ? await pngEvidence(entry.resolvedPath)
      : {
          path: null,
          exists: false,
          sizeBytes: null,
          sha256: null,
          pngSignatureValid: false,
          decoded: false,
          decodeError: 'evidence_path_outside_allowed_roots',
          format: null,
          width: null,
          height: null,
        };
    const expectedHash = normalizeSha256(entry.expectedHash);
    const hashMatches = expectedHash ? fileEvidence.sha256 === expectedHash : null;
    evidence.push({
      ...fileEvidence,
      role: entry.role,
      sourcePath: entry.sourcePath,
      source_path: entry.sourcePath,
      absolutePath: fileEvidence.path,
      absolute_path: fileEvidence.path,
      path: relPath(fileEvidence.path, repoRoot),
      expectedHash,
      expected_hash: expectedHash,
      hashMatches,
      hash_matches: hashMatches,
    });
  }
  const imageCount = evidence.length;
  const existingImageCount = evidence.filter((item) => item.exists).length;
  const pngImageCount = evidence.filter((item) => item.pngSignatureValid).length;
  const decodedImageCount = evidence.filter((item) => item.decoded).length;
  const declaredHashCount = evidence.filter((item) => item.expectedHash).length;
  const contentAddressedHashCount = evidence.filter((item) =>
    item.expectedHash && contentAddressedSha256(item.expectedHash)
  ).length;
  const hashMatchedCount = evidence.filter((item) => item.expectedHash && item.hashMatches === true).length;
  const allImagesExist = imageCount > 0 && existingImageCount === imageCount;
  const allImagesArePng = imageCount > 0 && pngImageCount === imageCount;
  const allImagesDecode = imageCount > 0 && decodedImageCount === imageCount;
  const allImagesAreDecodedPng = allImagesArePng && allImagesDecode;
  const allRequiredHashesDeclared = !options.requireDeclaredHashes
    || (imageCount > 0 && declaredHashCount === imageCount);
  const allDeclaredHashesContentAddressed =
    declaredHashCount === 0 || contentAddressedHashCount === declaredHashCount;
  const allDeclaredHashesMatch = declaredHashCount === 0 || hashMatchedCount === declaredHashCount;
  const visualPair = await recomputeVisualPairEvidence(evidence);
  const singleFrame = await recomputeSingleVisualFrameEvidence(evidence);
  const visualThresholds = visualThresholdRequirements(metrics);
  const visualThresholdValidation = visualThresholdValidationForPair(visualPair, visualThresholds);
  const hasBeforeImage = evidence.some((item) => item.role === 'before');
  const hasAfterImage = evidence.some((item) => item.role === 'after');
  const hasDiffImage = evidence.some((item) => item.role === 'diff');
  const beforeHashDeclared = evidence.some((item) =>
    item.role === 'before' && item.expectedHash && contentAddressedSha256(item.expectedHash)
  );
  const afterHashDeclared = evidence.some((item) =>
    item.role === 'after' && item.expectedHash && contentAddressedSha256(item.expectedHash)
  );
  const diffHashDeclared = evidence.some((item) =>
    item.role === 'diff' && item.expectedHash && contentAddressedSha256(item.expectedHash)
  );
  const requiresPixelProof = options.required === true;
  const pixelProofAccepted = options.allowSingleFrameProof === true
    ? visualPair.accepted === true || singleFrame.accepted === true
    : visualPair.accepted === true;
  const failedGates = compactStringList([
    imageCount > 0 || options.required !== true ? null : 'visual_artifacts_missing',
    allImagesExist || imageCount === 0 ? null : 'visual_artifact_file_missing',
    allImagesArePng || imageCount === 0 ? null : 'visual_artifact_not_png',
    allImagesDecode || imageCount === 0 ? null : 'visual_artifact_decode_failed',
    allRequiredHashesDeclared ? null : 'visual_artifact_declared_hash_missing',
    allDeclaredHashesContentAddressed ? null : 'visual_artifact_hash_not_content_addressed',
    allDeclaredHashesMatch ? null : 'visual_artifact_hash_mismatch',
    options.required === true && options.allowSingleFrameProof !== true && !hasBeforeImage ? 'visual_before_artifact_missing' : null,
    options.required === true && options.allowSingleFrameProof !== true && !hasAfterImage ? 'visual_after_artifact_missing' : null,
    options.requireDiff === true && !hasDiffImage ? 'visual_diff_artifact_missing' : null,
    options.requireDeclaredHashes === true && !beforeHashDeclared ? 'visual_before_artifact_hash_missing' : null,
    options.requireDeclaredHashes === true && !afterHashDeclared ? 'visual_after_artifact_hash_missing' : null,
    options.requireDeclaredHashes === true && options.requireDiff === true && !diffHashDeclared ? 'visual_diff_artifact_hash_missing' : null,
    requiresPixelProof && pixelProofAccepted !== true
      ? options.allowSingleFrameProof === true
        ? 'visual_single_frame_pixel_recompute_not_accepted'
        : 'visual_pair_pixel_recompute_not_accepted'
      : null,
    ...(visualThresholdValidation.failedGates ?? []),
  ]);
  const accepted = imageCount === 0
    ? options.required !== true
    : allImagesExist
      && allImagesAreDecodedPng
      && allRequiredHashesDeclared
      && allDeclaredHashesContentAddressed
      && allDeclaredHashesMatch
      && (options.requireDiff !== true || hasDiffImage)
      && visualThresholdValidation.accepted === true
      && (!requiresPixelProof || pixelProofAccepted === true);
  return {
    required: options.required,
    requireDeclaredHashes: options.requireDeclaredHashes,
    require_declared_hashes: options.requireDeclaredHashes,
    requireDiff: options.requireDiff,
    require_diff: options.requireDiff,
    allowSingleFrameProof: options.allowSingleFrameProof,
    allow_single_frame_proof: options.allowSingleFrameProof,
    present: imageCount > 0,
    accepted,
    imageCount,
    existingImageCount,
    pngImageCount,
    decodedImageCount,
    declaredHashCount,
    contentAddressedHashCount,
    hashMatchedCount,
    allRequiredHashesDeclared,
    all_required_hashes_declared: allRequiredHashesDeclared,
    allDeclaredHashesContentAddressed,
    all_declared_hashes_content_addressed: allDeclaredHashesContentAddressed,
    allImagesExist,
    allImagesArePng,
    allImagesDecode,
    allImagesAreDecodedPng,
    allDeclaredHashesMatch,
    hasBeforeImage,
    has_before_image: hasBeforeImage,
    hasAfterImage,
    has_after_image: hasAfterImage,
    hasDiffImage,
    has_diff_image: hasDiffImage,
    beforeHashDeclared,
    before_hash_declared: beforeHashDeclared,
    afterHashDeclared,
    after_hash_declared: afterHashDeclared,
    diffHashDeclared,
    diff_hash_declared: diffHashDeclared,
    changedPixelRatio: finiteNumber(metrics.changedPixelRatio ?? metrics.changed_pixel_ratio),
    meanAbsDelta8bit: finiteNumber(metrics.meanAbsDelta8bit ?? metrics.mean_abs_delta_8bit),
    visiblePixelCount: finiteNumber(metrics.visiblePixelCount ?? metrics.visible_pixel_count),
    visualThresholds,
    visual_thresholds: visualThresholds,
    visualThresholdValidation,
    visual_threshold_validation: visualThresholdValidation,
    recomputedVisualPair: visualPair,
    recomputed_visual_pair: visualPair,
    recomputedSingleFrame: singleFrame,
    recomputed_single_frame: singleFrame,
    failedGates,
    failed_gates: failedGates,
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

function canonicalTargetKey(row) {
  const supportedScope = firstText(
    row.supportedPipelineScope,
    row.supported_pipeline_scope,
    row.validationScope,
    row.validation_scope,
  );
  if (row.proofMode === 'hip_module_runtime_readback' && supportedScope) {
    return `${row.proofMode}:${supportedScope}`;
  }
  return firstText(row.targetId, row.profileId) ?? 'unknown';
}

function rowAttemptKey(row) {
  const runModeKey = (
    row.proofMode === 'run_mode_proof'
    || row.matrixOutcome === 'full_runtime_gpu_hmr'
    || row.matrixOutcome === 'cold_split_proven'
  )
    ? row.runMode?.metricScope ?? 'unknown'
    : null;
  return [
    row.backend ?? 'unknown',
    canonicalTargetKey(row),
    row.profileId ?? 'unknown',
    row.proofMode ?? 'unknown',
    runModeKey,
    row.evidenceKind ?? 'unknown',
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

function contentAddressedSha256(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value ?? ''));
}

function contentAddressedArtifactHash(value) {
  return /^(?:artifact:)?sha256:[a-f0-9]{64}$/i.test(String(value ?? ''));
}

function normalizedArtifactHash(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const match = raw.match(/^(?:artifact:)?(sha256:[a-f0-9]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function rawValidationProfileEvidence(row = {}) {
  return compactObject(
    row.validationProfileEvidence
      ?? row.validation_profile_evidence
      ?? row.validationProfile
      ?? row.validation_profile
      ?? row.profileEvidence
      ?? row.profile_evidence,
  );
}

function rawSourceFirstIngestionEvidence(row = {}) {
  return compactObject(
    row.sourceFirstIngestion
      ?? row.source_first_ingestion
      ?? row.sourceFirstIngestionEvidence
      ?? row.source_first_ingestion_evidence,
  );
}

function rawVisualArtifactTransportEvidence(row = {}) {
  const visualArtifacts = compactObject(
    row.visualArtifacts
      ?? row.visual_artifacts
      ?? row.visualOracleArtifacts
      ?? row.visual_oracle_artifacts,
  );
  return {
    visualArtifacts,
    locators: compactObjectList(
      visualArtifacts.artifactCasLocators
        ?? visualArtifacts.artifact_cas_locators,
    ),
    transportEvidence: compactObject(
      visualArtifacts.visualArtifactTransportEvidence
        ?? visualArtifacts.visual_artifact_transport_evidence,
    ),
  };
}

function normalizedVisualArtifactRole(value) {
  const role = String(value ?? '').trim().toLowerCase();
  if (role === 'before' || role === 'before_frame' || role === 'baseline_frame') return 'before';
  if (role === 'after' || role === 'after_frame' || role === 'changed_frame') return 'after';
  if (role === 'diff' || role === 'diff_frame' || role === 'difference_frame') return 'diff';
  return role || null;
}

function visualImageHashesByRole(visual = {}) {
  const byRole = new Map();
  for (const image of compactObjectList(visual.images)) {
    const role = normalizedVisualArtifactRole(image.role);
    const hash = normalizedArtifactHash(
      image.sha256
        ?? image.expectedHash
        ?? image.expected_hash
        ?? image.hash
        ?? image.contentHash
        ?? image.content_hash,
    );
    if (role && hash) byRole.set(role, hash);
  }
  return byRole;
}

function declaredVisualArtifactHashesByRole(visualArtifacts = {}) {
  return new Map([
    ['before', normalizedArtifactHash(
      visualArtifacts.beforeImageHash
        ?? visualArtifacts.before_image_hash
        ?? visualArtifacts.baselineImageHash
        ?? visualArtifacts.baseline_image_hash,
    )],
    ['after', normalizedArtifactHash(
      visualArtifacts.afterImageHash
        ?? visualArtifacts.after_image_hash
        ?? visualArtifacts.changedImageHash
        ?? visualArtifacts.changed_image_hash,
    )],
    ['diff', normalizedArtifactHash(
      visualArtifacts.diffImageHash
        ?? visualArtifacts.diff_image_hash
        ?? visualArtifacts.differenceImageHash
        ?? visualArtifacts.difference_image_hash,
    )],
  ].filter(([, hash]) => Boolean(hash)));
}

function locatorHashesByRole(locators = []) {
  const byRole = new Map();
  for (const locator of compactObjectList(locators)) {
    const role = normalizedVisualArtifactRole(locator.role ?? locator.artifactRole ?? locator.artifact_role);
    const hash = normalizedArtifactHash(locator.contentHash ?? locator.content_hash ?? locator.artifactId ?? locator.artifact_id);
    if (role && hash) byRole.set(role, hash);
  }
  return byRole;
}

function visualHashesMatchByRole(expectedByRole, actualByRole, roles) {
  return roles.every((role) => {
    const expected = expectedByRole.get(role);
    const actual = actualByRole.get(role);
    return Boolean(expected) && Boolean(actual) && expected === actual;
  });
}

function visualLocatorTransportAccepted(locator) {
  const transport = compactObject(locator.transport);
  const transportKind = firstText(transport.kind, locator.transportKind, locator.transport_kind);
  return contentAddressedArtifactHash(locator.contentHash ?? locator.content_hash ?? locator.artifactId ?? locator.artifact_id)
    && firstBool(transport.contentAddressed, transport.content_addressed) === true
    && firstBool(transport.manifestOnly, transport.manifest_only) === true
    && firstBool(transport.bytesEmbedded, transport.bytes_embedded) === false
    && firstText(locator.proofAuthority, locator.proof_authority) === 'transport_integrity_only'
    && firstBool(locator.acceptedForGpuHmr, locator.accepted_for_gpu_hmr) === false
    && firstBool(locator.gpuHmrSuccess, locator.gpu_hmr_success) === false
    && Boolean(transportKind);
}

function asyncVisualMetricsFromVisualEvidence(visual = {}) {
  return compactObject(
    visual.recomputedVisualPair?.asyncVisualMetrics
      ?? visual.recomputedVisualPair?.async_visual_metrics
      ?? visual.recomputed_visual_pair?.asyncVisualMetrics
      ?? visual.recomputed_visual_pair?.async_visual_metrics
      ?? visual.recomputedSingleFrame?.asyncVisualMetrics
      ?? visual.recomputedSingleFrame?.async_visual_metrics
      ?? visual.recomputed_single_frame?.asyncVisualMetrics
      ?? visual.recomputed_single_frame?.async_visual_metrics,
  );
}

function asyncVisualCasBundleFacet(row = {}, visual = {}) {
  const { visualArtifacts, locators, transportEvidence } = rawVisualArtifactTransportEvidence(row);
  const asyncMetrics = asyncVisualMetricsFromVisualEvidence(visual);
  const worker = compactObject(asyncMetrics.worker);
  const incremental = compactObject(asyncMetrics.incremental);
  const tileEvidence = compactObject(asyncMetrics.tileEvidence ?? asyncMetrics.tile_evidence);
  const inputHashes = compactObject(asyncMetrics.inputHashes ?? asyncMetrics.input_hashes);
  const declaredByRole = declaredVisualArtifactHashesByRole(visualArtifacts);
  const locatorByRole = locatorHashesByRole(locators);
  const matrixByRole = visualImageHashesByRole(visual);
  const requiredRoles = compactStringList([
    visual.hasBeforeImage || visual.has_before_image ? 'before' : null,
    visual.hasAfterImage || visual.has_after_image ? 'after' : null,
    visual.hasDiffImage || visual.has_diff_image || visual.requireDiff || visual.require_diff ? 'diff' : null,
  ]);
  const requiredRoleSet = requiredRoles.length > 0 ? requiredRoles : ['before', 'after'];
  const locatorRolesPresent = requiredRoleSet.every((role) => locatorByRole.has(role));
  const casHashesMatchDeclaredVisualHashes = visualHashesMatchByRole(declaredByRole, locatorByRole, requiredRoleSet);
  const casHashesMatchMatrixVisualHashes = visualHashesMatchByRole(matrixByRole, locatorByRole, requiredRoleSet);
  const asyncBeforeHash = normalizedArtifactHash(inputHashes.beforeEncodedHash ?? inputHashes.before_encoded_hash);
  const asyncAfterHash = normalizedArtifactHash(inputHashes.afterEncodedHash ?? inputHashes.after_encoded_hash);
  const asyncInputHashesMatchCas =
    (!locatorByRole.has('before') || locatorByRole.get('before') === asyncBeforeHash)
    && (!locatorByRole.has('after') || locatorByRole.get('after') === asyncAfterHash);
  const transportAccepted =
    transportEvidence.accepted === true
    && transportEvidence.acceptedAsTransportEvidence === true
    && firstText(transportEvidence.proofAuthority, transportEvidence.proof_authority)
      === 'transport_integrity_only_not_visual_or_ledger_proof'
    && firstBool(transportEvidence.acceptedForGpuHmr, transportEvidence.accepted_for_gpu_hmr) === false
    && firstBool(transportEvidence.gpuHmrSuccess, transportEvidence.gpu_hmr_success) === false;
  const locatorsAccepted = locators.length >= requiredRoleSet.length
    && locators.every(visualLocatorTransportAccepted);
  const workerExecutableHash = firstText(worker.executableHash, worker.executable_hash);
  const asyncMetricsAccepted =
    firstText(asyncMetrics.schemaVersion, asyncMetrics.schema_version)
      === GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION
    && firstText(asyncMetrics.eventType, asyncMetrics.event_type) === 'proof_ready'
    && asyncMetrics.accepted === true
    && firstBool(asyncMetrics.acceptedAsAsyncVisualMetrics, asyncMetrics.accepted_as_async_visual_metrics) === true
    && firstText(asyncMetrics.proofAuthority, asyncMetrics.proof_authority)
      === GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY
    && firstBool(asyncMetrics.acceptedForGpuHmr, asyncMetrics.accepted_for_gpu_hmr) === false
    && firstBool(asyncMetrics.gpuHmrSuccess, asyncMetrics.gpu_hmr_success) === false
    && firstBool(worker.offMainThread, worker.off_main_thread) === true
    && contentAddressedSha256(workerExecutableHash);
  const tileEvidenceAccepted =
    tileEvidence.accepted === true
    && Number(tileEvidence.tileCount ?? tileEvidence.tile_count ?? 0) > 0;
  const tileHashingEnabled = firstBool(incremental.tileHashing, incremental.tile_hashing) === true;
  const roiEarlyExitClaimed =
    firstBool(asyncMetrics.roiEarlyExitUsed, asyncMetrics.roi_early_exit_used) === true
    || firstBool(incremental.deepDiffSkipped, incremental.deep_diff_skipped) === true
    || firstBool(asyncMetrics.roiEvidence?.earlyExit, asyncMetrics.roiEvidence?.early_exit) === true
    || firstBool(asyncMetrics.roi_evidence?.early_exit) === true;
  const failedGates = compactStringList([
    Object.keys(visualArtifacts).length > 0 ? null : 'async_visual_cas_artifacts_missing',
    visual.accepted === true ? null : 'visual_artifacts_not_accepted',
    Object.keys(asyncMetrics).length > 0 ? null : 'async_visual_metrics_missing',
    asyncMetricsAccepted ? null : 'async_visual_worker_proof_not_accepted',
    firstText(asyncMetrics.eventType, asyncMetrics.event_type) === 'proof_ready'
      ? null
      : 'async_visual_proof_ready_event_missing',
    firstBool(worker.offMainThread, worker.off_main_thread) === true
      ? null
      : 'async_visual_worker_not_off_main_thread',
    contentAddressedSha256(workerExecutableHash)
      ? null
      : 'async_visual_worker_executable_hash_missing',
    transportAccepted ? null : 'visual_artifact_transport_not_accepted',
    locatorsAccepted ? null : 'visual_artifact_cas_locators_not_accepted',
    locatorRolesPresent ? null : 'visual_artifact_cas_roles_missing',
    casHashesMatchDeclaredVisualHashes ? null : 'visual_artifact_cas_declared_hash_mismatch',
    casHashesMatchMatrixVisualHashes ? null : 'visual_artifact_cas_matrix_hash_mismatch',
    asyncInputHashesMatchCas ? null : 'async_visual_input_hash_cas_mismatch',
    tileHashingEnabled ? null : 'async_visual_tile_hashing_missing',
    tileEvidenceAccepted ? null : 'async_visual_tile_evidence_missing',
    roiEarlyExitClaimed && !tileEvidenceAccepted
      ? 'async_visual_roi_early_exit_tile_evidence_missing'
      : null,
  ]);
  return {
    present: Object.keys(visualArtifacts).length > 0 || Object.keys(asyncMetrics).length > 0,
    accepted: failedGates.length === 0,
    acceptedAsSupportEvidence: failedGates.length === 0,
    accepted_as_support_evidence: failedGates.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    proofAuthority: ASYNC_VISUAL_CAS_SUPPORT_AUTHORITY,
    proof_authority: ASYNC_VISUAL_CAS_SUPPORT_AUTHORITY,
    asyncVisualProofAccepted: asyncMetricsAccepted,
    async_visual_proof_accepted: asyncMetricsAccepted,
    proofReady: firstText(asyncMetrics.eventType, asyncMetrics.event_type) === 'proof_ready',
    proof_ready: firstText(asyncMetrics.eventType, asyncMetrics.event_type) === 'proof_ready',
    offMainThread: firstBool(worker.offMainThread, worker.off_main_thread),
    off_main_thread: firstBool(worker.offMainThread, worker.off_main_thread),
    workerExecutableHash,
    worker_executable_hash: workerExecutableHash,
    transportAccepted,
    transport_accepted: transportAccepted,
    locatorCount: locators.length,
    locator_count: locators.length,
    requiredRoles: requiredRoleSet,
    required_roles: requiredRoleSet,
    casHashesMatchDeclaredVisualHashes,
    cas_hashes_match_declared_visual_hashes: casHashesMatchDeclaredVisualHashes,
    casHashesMatchMatrixVisualHashes,
    cas_hashes_match_matrix_visual_hashes: casHashesMatchMatrixVisualHashes,
    asyncInputHashesMatchCas,
    async_input_hashes_match_cas: asyncInputHashesMatchCas,
    tileHashingEnabled,
    tile_hashing_enabled: tileHashingEnabled,
    tileEvidenceAccepted,
    tile_evidence_accepted: tileEvidenceAccepted,
    roiEarlyExitClaimed,
    roi_early_exit_claimed: roiEarlyExitClaimed,
    failedGates,
    failed_gates: failedGates,
  };
}

function normalizedEvidenceRelPath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '');
}

function sourceFirstGeneratedArtifactPath(value) {
  const normalized = normalizedEvidenceRelPath(value).toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('.synthi/')
    || normalized.includes('/.synthi/')
    || normalized === '.synthi_split_meta.json'
    || normalized.endsWith('/.synthi_split_meta.json');
}

function pathListFromValue(value) {
  if (!Array.isArray(value)) return [];
  return compactStringList(value.map((entry) => {
    if (typeof entry === 'string') return normalizedEvidenceRelPath(entry);
    if (!isObject(entry)) return null;
    return normalizedEvidenceRelPath(
      entry.path
        ?? entry.name
        ?? entry.filename
        ?? entry.filePath
        ?? entry.file_path,
    );
  }));
}

function sourceFirstIngestionFacet(row = {}) {
  const supplied = rawSourceFirstIngestionEvidence(row);
  const compileContract = compactObject(
    supplied.initialCompileContract
      ?? supplied.initial_compile_contract,
  );
  const sourcePurity = compactObject(
    supplied.sourcePurityEvidence
      ?? supplied.source_purity_evidence,
  );
  const schemaVersion = firstText(supplied.schemaVersion, supplied.schema);
  const proofAuthority = firstText(supplied.proofAuthority, supplied.proof_authority);
  const acceptedFlag = firstBool(supplied.accepted, supplied.sourceFirstAccepted, supplied.source_first_accepted);
  const acceptedForGpuHmr = firstBool(supplied.acceptedForGpuHmr, supplied.accepted_for_gpu_hmr);
  const gpuHmrSuccess = firstBool(supplied.gpuHmrSuccess, supplied.gpu_hmr_success);
  const sourceAuthority = firstText(
    supplied.sourceAuthority,
    supplied.source_authority,
    row.sourceAuthority,
    row.source_authority,
  );
  const canSatisfyRuntimeProof = firstBool(
    supplied.canSatisfyRuntimeProof,
    supplied.can_satisfy_runtime_proof,
  );
  const sourceContentHash = firstText(
    supplied.sourceContentHash,
    supplied.source_content_hash,
    sourcePurity.sourceContentHash,
    sourcePurity.source_content_hash,
  );
  const noSynthiAbiInSeedSource = firstBool(
    supplied.noSynthiAbiInSeedSource,
    supplied.no_synthi_abi_in_seed_source,
    sourcePurity.noSynthiAbiInSeedSource,
    sourcePurity.no_synthi_abi_in_seed_source,
    sourcePurity.accepted,
  );
  const useAiSplit = firstBool(
    supplied.useAiSplit,
    supplied.use_ai_split,
    compileContract.useAiSplit,
    compileContract.use_ai_split,
  );
  const userRequestedAi = firstBool(
    supplied.userRequestedAi,
    supplied.user_requested_ai,
    compileContract.userRequestedAi,
    compileContract.user_requested_ai,
  );
  const preferGpuPipeline = firstBool(
    supplied.preferGpuPipeline,
    supplied.prefer_gpu_pipeline,
    compileContract.preferGpuPipeline,
    compileContract.prefer_gpu_pipeline,
  );
  const gpuSplitEndpointObserved = firstBool(
    supplied.gpuSplitEndpointObserved,
    supplied.gpu_split_endpoint_observed,
  );
  const generatedArtifactCreatedAfterAiSplit = firstBool(
    supplied.generatedArtifactCreatedAfterAiSplit,
    supplied.generated_artifact_created_after_ai_split,
  );
  const initialFileEntries = compactObjectList(
    compileContract.initialFiles
      ?? compileContract.initial_files
      ?? supplied.initialFiles
      ?? supplied.initial_files,
  ).map((entry) => ({
    path: normalizedEvidenceRelPath(
      entry.path
        ?? entry.name
        ?? entry.filename
        ?? entry.filePath
        ?? entry.file_path,
    ),
    contentHash: firstText(
      entry.contentHash,
      entry.content_hash,
      entry.hash,
      entry.sha256,
    ),
    content_hash: firstText(
      entry.contentHash,
      entry.content_hash,
      entry.hash,
      entry.sha256,
    ),
    byteLength: Number.isFinite(Number(entry.byteLength ?? entry.byte_length))
      ? Number(entry.byteLength ?? entry.byte_length)
      : null,
    byte_length: Number.isFinite(Number(entry.byteLength ?? entry.byte_length))
      ? Number(entry.byteLength ?? entry.byte_length)
      : null,
  })).filter((entry) => entry.path);
  const initialFilePaths = pathListFromValue(
    compileContract.initialFilePaths
      ?? compileContract.initial_file_paths
      ?? compileContract.initialFiles
      ?? compileContract.initial_files
      ?? supplied.initialFilePaths
      ?? supplied.initial_file_paths
      ?? supplied.initialFiles
      ?? supplied.initial_files,
  );
  const normalizedInitialFilePaths = compactStringList([
    ...initialFilePaths,
    ...initialFileEntries.map((entry) => entry.path),
  ]);
  const initialManifestHash = firstText(
    supplied.initialManifestHash,
    supplied.initial_manifest_hash,
    compileContract.initialManifestHash,
    compileContract.initial_manifest_hash,
  );
  const recomputedInitialManifestHash = initialFileEntries.length > 0
    ? `sha256:${sha256Hex(stableJson(initialFileEntries))}`
    : null;
  const initialManifestHashMatches =
    contentAddressedSha256(initialManifestHash)
    && Boolean(recomputedInitialManifestHash)
    && initialManifestHash === recomputedInitialManifestHash;
  const sourceTreeManifestHash = firstText(
    supplied.sourceTreeManifestHash,
    supplied.source_tree_manifest_hash,
    compileContract.sourceTreeManifestHash,
    compileContract.source_tree_manifest_hash,
  );
  const sourceTreeManifestRequired = sourceAuthority === 'profile_source_files';
  const sourceTreeManifestHashMatches =
    sourceTreeManifestHash
      ? contentAddressedSha256(sourceTreeManifestHash)
        && Boolean(recomputedInitialManifestHash)
        && sourceTreeManifestHash === recomputedInitialManifestHash
      : !sourceTreeManifestRequired;
  const entryPath = normalizedEvidenceRelPath(firstText(
    supplied.entryPath,
    supplied.entry_path,
    supplied.seededWorkspacePath,
    supplied.seeded_workspace_path,
    compileContract.filename,
  ));
  const initialSourceEntries = initialFileEntries
    .filter((entry) => entry.path === entryPath);
  const initialSourceFilePresent =
    initialSourceEntries.length > 0
    && normalizedInitialFilePaths.includes(entryPath);
  const initialSourceHashMatches =
    initialSourceFilePresent
    && initialSourceEntries.some((entry) => entry.contentHash === sourceContentHash);
  const declaredPreexistingGeneratedArtifactPaths = pathListFromValue(
    supplied.preexistingGeneratedArtifactPaths
      ?? supplied.preexisting_generated_artifact_paths,
  );
  const detectedInitialGeneratedArtifactPaths = normalizedInitialFilePaths.filter(sourceFirstGeneratedArtifactPath);
  const preexistingGeneratedArtifactPaths = compactStringList([
    ...declaredPreexistingGeneratedArtifactPaths,
    ...detectedInitialGeneratedArtifactPaths,
  ]);
  const preexistingGeneratedArtifactsPresent = firstBool(
    supplied.preexistingGeneratedArtifactsPresent,
    supplied.preexisting_generated_artifacts_present,
  ) ?? preexistingGeneratedArtifactPaths.length > 0;
  const generatedArtifacts = compactObjectList(
    supplied.generatedArtifacts
      ?? supplied.generated_artifacts,
  );
  const generatedArtifactPaths = compactStringList([
    ...pathListFromValue(supplied.generatedArtifactPaths ?? supplied.generated_artifact_paths),
    ...pathListFromValue(generatedArtifacts),
  ]);
  const generatedArtifactPathsInGeneratedNamespace =
    generatedArtifactPaths.length > 0
    && generatedArtifactPaths.every(sourceFirstGeneratedArtifactPath);
  const generatedArtifactHashes = compactStringList([
    ...(Array.isArray(supplied.generatedArtifactHashes) ? supplied.generatedArtifactHashes : []),
    ...(Array.isArray(supplied.generated_artifact_hashes) ? supplied.generated_artifact_hashes : []),
    ...generatedArtifacts.map((entry) => firstText(
      entry.contentHash,
      entry.content_hash,
      entry.hash,
      entry.sha256,
    )),
  ]);
  const sidecarHash = firstText(supplied.sidecarHash, supplied.sidecar_hash);
  const compileManifestHash = firstText(
    supplied.compileManifestHash,
    supplied.compile_manifest_hash,
    supplied.manifestHash,
    supplied.manifest_hash,
  );
  const generatedBoundaryHashSet = new Set(compactStringList([
    ...generatedArtifactHashes,
    sidecarHash,
    compileManifestHash,
  ])
    .map(normalizedArtifactHash)
    .filter(Boolean));
  const preexistingGeneratedArtifactHashOverlaps = initialFileEntries
    .map((entry) => {
      const contentHash = normalizedArtifactHash(entry.contentHash ?? entry.content_hash);
      if (!contentHash || !generatedBoundaryHashSet.has(contentHash)) return null;
      return {
        path: entry.path,
        contentHash,
        content_hash: contentHash,
      };
    })
    .filter(Boolean);
  const targetId = firstText(supplied.targetId, supplied.target_id);
  const rowTargetId = firstText(row.targetId, row.target_id, row.projectId, row.project_id);
  const targetIdBoundToRow = Boolean(targetId) && Boolean(rowTargetId) && targetId === rowTargetId;
  const evidenceRefs = compactStringList(supplied.evidenceRefs ?? supplied.evidence_refs);
  const generatedArtifactHashesAccepted =
    generatedArtifactHashes.length > 0
    && generatedArtifactHashes.every(contentAddressedSha256);
  const suppliedProofId = firstText(supplied.proofId, supplied.proof_id);
  const recomputedProofId = proofIdFor('agent-split-source-first-ingestion', {
    sourceContentHash,
    entryPath,
    targetId,
    initialManifestHash,
    generatedArtifactHashes,
    sidecarHash,
    compileManifestHash,
  });
  const proofIdMatches =
    Boolean(suppliedProofId)
    && suppliedProofId === recomputedProofId;
  const failedGates = compactStringList([
    Object.keys(supplied).length > 0 ? null : 'source_first_ingestion_evidence_missing',
    schemaVersion === AGENT_SPLIT_SOURCE_FIRST_INGESTION_SCHEMA_VERSION
      ? null
      : 'source_first_ingestion_schema_missing',
    proofAuthority === AGENT_SPLIT_SOURCE_FIRST_INGESTION_AUTHORITY
      ? null
      : 'source_first_ingestion_authority_not_provenance_only',
    acceptedFlag === true ? null : 'source_first_ingestion_not_explicitly_accepted',
    acceptedForGpuHmr === false ? null : 'source_first_ingestion_must_not_claim_gpu_hmr_acceptance',
    gpuHmrSuccess === false ? null : 'source_first_ingestion_must_not_claim_gpu_hmr_success',
    canSatisfyRuntimeProof === false ? null : 'source_first_ingestion_must_not_claim_runtime_proof_authority',
    proofIdMatches ? null : 'source_first_proof_id_mismatch',
    contentAddressedSha256(sourceContentHash) ? null : 'source_first_seed_source_hash_missing',
    noSynthiAbiInSeedSource === true ? null : 'source_first_seed_source_contains_synthi_abi',
    useAiSplit === true ? null : 'source_first_compile_use_ai_split_missing',
    userRequestedAi === true ? null : 'source_first_compile_user_requested_ai_missing',
    preferGpuPipeline === true ? null : 'source_first_compile_prefer_gpu_pipeline_missing',
    initialFileEntries.length > 0 ? null : 'source_first_initial_file_manifest_missing',
    initialSourceFilePresent ? null : 'source_first_initial_source_file_missing',
    initialSourceHashMatches ? null : 'source_first_initial_source_hash_mismatch',
    initialManifestHashMatches ? null : 'source_first_initial_manifest_hash_mismatch',
    sourceTreeManifestHashMatches ? null : 'source_first_source_tree_manifest_mismatch',
    gpuSplitEndpointObserved === true ? null : 'source_first_gpu_split_endpoint_not_observed',
    generatedArtifactCreatedAfterAiSplit === true
      ? null
      : 'source_first_generated_artifact_boundary_not_proven',
    generatedArtifactPaths.length > 0 ? null : 'source_first_generated_artifact_paths_missing',
    generatedArtifactPathsInGeneratedNamespace ? null : 'source_first_generated_artifact_namespace_unproven',
    generatedArtifactHashesAccepted ? null : 'source_first_generated_artifact_hashes_missing',
    contentAddressedSha256(sidecarHash) ? null : 'source_first_sidecar_hash_missing',
    contentAddressedSha256(compileManifestHash) ? null : 'source_first_compile_manifest_hash_missing',
    targetIdBoundToRow ? null : 'source_first_target_id_not_bound_to_row',
    preexistingGeneratedArtifactsPresent === false && preexistingGeneratedArtifactPaths.length === 0
      ? null
      : 'source_first_precompiled_generated_artifacts_present',
    preexistingGeneratedArtifactHashOverlaps.length === 0
      ? null
      : 'source_first_precompiled_generated_artifact_hash_overlap',
    evidenceRefs.length > 0 ? null : 'source_first_evidence_refs_missing',
  ]);
  return {
    present: Object.keys(supplied).length > 0,
    accepted: failedGates.length === 0,
    schemaVersion,
    schema_version: schemaVersion,
    proofAuthority,
    proof_authority: proofAuthority,
    acceptedForGpuHmr,
    accepted_for_gpu_hmr: acceptedForGpuHmr,
    gpuHmrSuccess,
    gpu_hmr_success: gpuHmrSuccess,
    canSatisfyRuntimeProof,
    can_satisfy_runtime_proof: canSatisfyRuntimeProof,
    proofId: suppliedProofId,
    proof_id: suppliedProofId,
    recomputedProofId,
    recomputed_proof_id: recomputedProofId,
    proofIdMatches,
    proof_id_matches: proofIdMatches,
    sourceAuthority,
    source_authority: sourceAuthority,
    sourceContentHash,
    source_content_hash: sourceContentHash,
    entryPath,
    entry_path: entryPath,
    noSynthiAbiInSeedSource,
    no_synthi_abi_in_seed_source: noSynthiAbiInSeedSource,
    useAiSplit,
    use_ai_split: useAiSplit,
    userRequestedAi,
    user_requested_ai: userRequestedAi,
    preferGpuPipeline,
    prefer_gpu_pipeline: preferGpuPipeline,
    gpuSplitEndpointObserved,
    gpu_split_endpoint_observed: gpuSplitEndpointObserved,
    generatedArtifactCreatedAfterAiSplit,
    generated_artifact_created_after_ai_split: generatedArtifactCreatedAfterAiSplit,
    initialFilePaths: normalizedInitialFilePaths,
    initial_file_paths: normalizedInitialFilePaths,
    initialFiles: initialFileEntries,
    initial_files: initialFileEntries,
    initialManifestHash,
    initial_manifest_hash: initialManifestHash,
    recomputedInitialManifestHash,
    recomputed_initial_manifest_hash: recomputedInitialManifestHash,
    initialManifestHashMatches,
    initial_manifest_hash_matches: initialManifestHashMatches,
    sourceTreeManifestHash,
    source_tree_manifest_hash: sourceTreeManifestHash,
    sourceTreeManifestRequired,
    source_tree_manifest_required: sourceTreeManifestRequired,
    sourceTreeManifestHashMatches,
    source_tree_manifest_hash_matches: sourceTreeManifestHashMatches,
    initialSourceFilePresent,
    initial_source_file_present: initialSourceFilePresent,
    initialSourceHashMatches,
    initial_source_hash_matches: initialSourceHashMatches,
    preexistingGeneratedArtifactsPresent,
    preexisting_generated_artifacts_present: preexistingGeneratedArtifactsPresent,
    preexistingGeneratedArtifactPaths,
    preexisting_generated_artifact_paths: preexistingGeneratedArtifactPaths,
    preexistingGeneratedArtifactHashOverlaps,
    preexisting_generated_artifact_hash_overlaps: preexistingGeneratedArtifactHashOverlaps,
    generatedArtifactPaths,
    generated_artifact_paths: generatedArtifactPaths,
    generatedArtifactPathsInGeneratedNamespace,
    generated_artifact_paths_in_generated_namespace: generatedArtifactPathsInGeneratedNamespace,
    generatedArtifactHashes,
    generated_artifact_hashes: generatedArtifactHashes,
    sidecarHash,
    sidecar_hash: sidecarHash,
    compileManifestHash,
    compile_manifest_hash: compileManifestHash,
    targetId,
    target_id: targetId,
    targetIdBoundToRow,
    target_id_bound_to_row: targetIdBoundToRow,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    failedGates,
    failed_gates: failedGates,
  };
}

function rowEvidenceRefs(row = {}) {
  const ledgerRecord = ledgerRecordForRow(row);
  return compactStringList([
    ...(Array.isArray(row.evidenceRefs) ? row.evidenceRefs : []),
    ...(Array.isArray(row.evidence_refs) ? row.evidence_refs : []),
    ...evidenceRefsFromValue(ledgerRecord),
    ...evidenceRefsFromValue(row.runtimeProofArtifact ?? row.runtime_proof_artifact),
    ...evidenceRefsFromValue(row.visual),
    ...evidenceRefsFromValue(row.sourceFirstIngestion ?? row.source_first_ingestion),
  ]);
}

function visualArtifactHashesForRow(row = {}) {
  return compactStringList([
    ...(Array.isArray(row.visual?.images)
      ? row.visual.images.map((image) => firstText(
          image.expectedHash,
          image.expected_hash,
          image.contentHash,
          image.content_hash,
          image.sha256,
        ))
      : []),
    ...artifactPathsFromValue(row.visualEvidenceArtifacts ?? row.visual_evidence_artifacts)
      .filter(contentAddressedSha256),
  ]);
}

function validationProfileEvidenceBindingFacet(row = {}, supplied = {}) {
  const proofIds = compactStringList(supplied.proofIds ?? supplied.proof_ids);
  const evidenceRefs = compactStringList(supplied.evidenceRefs ?? supplied.evidence_refs);
  const profileHash = firstText(supplied.profileHash, supplied.profile_hash);
  const sourceContentHash = firstText(
    supplied.sourceContentHash,
    supplied.source_content_hash,
    supplied.sourceHash,
    supplied.source_hash,
  );
  const declaredSourceContentHash = firstText(
    supplied.declaredSourceContentHash,
    supplied.declared_source_content_hash,
  );
  const deterministicVisualModeHash = firstText(
    supplied.deterministicVisualModeHash,
    supplied.deterministic_visual_mode_hash,
  );
  const visualProofHash = firstText(supplied.visualProofHash, supplied.visual_proof_hash);
  const visualSceneManifestHash = firstText(
    supplied.visualSceneManifestHash,
    supplied.visual_scene_manifest_hash,
    supplied.renderSceneManifestHash,
    supplied.render_scene_manifest_hash,
  );
  const rowProofIds = new Set(compactStringList([
    ...(Array.isArray(row.proofIds) ? row.proofIds : []),
    ...(Array.isArray(row.proof_ids) ? row.proof_ids : []),
    row.ledger?.proofId,
    row.ledger?.proof_id,
    row.ledger?.record?.proofId,
    row.ledger?.record?.proof_id,
    row.runtimeProofArtifact?.proofId,
    row.runtimeProofArtifact?.proof_id,
    row.runtime_proof_artifact?.proofId,
    row.runtime_proof_artifact?.proof_id,
  ]));
  const evidenceRefSet = new Set(rowEvidenceRefs(row));
  const visualArtifactHashSet = new Set(visualArtifactHashesForRow(row));
  const ledgerRecord = ledgerRecordForRow(row);
  const profileId = firstText(supplied.profileId, supplied.profile_id, supplied.id);
  const profileClass = firstText(
    supplied.profileClass,
    supplied.profile_class,
    supplied.requirementId,
    supplied.requirement_id,
    supplied.coverageId,
    supplied.coverage_id,
  );
  const proofIdsBoundToRow =
    proofIds.length > 0
    && proofIds.every((proofId) => rowProofIds.has(proofId));
  const rowRuntimeIdentities = compactStringList([
    row.targetId,
    row.target_id,
    row.profileId,
    row.profile_id,
    row.validationProfileId,
    row.validation_profile_id,
    row.projectId,
    row.project_id,
    ledgerRecord.projectId,
    ledgerRecord.project_id,
    ledgerRecord.editId,
    ledgerRecord.edit_id,
  ]);
  const profileIdBoundToRow =
    Boolean(profileId)
    && rowRuntimeIdentities.some((identity) =>
      identity === profileId
      || identity.startsWith(`${profileId}:`)
      || identity.includes(`:${profileId}:`)
    );
  const evidenceRefsBound = evidenceRefs.filter((ref) =>
    evidenceRefSet.has(ref)
    || visualArtifactHashSet.has(ref)
    || rowProofIds.has(ref)
  );
  const evidenceRefsBoundToRow =
    evidenceRefs.length > 0
    && evidenceRefsBound.length > 0;
  const profileHashBoundToEvidenceRefs =
    !profileHash
    || (contentAddressedSha256(profileHash) && evidenceRefs.includes(profileHash));
  const sourceContentHashBoundToEvidenceRefs =
    !sourceContentHash
    || (contentAddressedSha256(sourceContentHash) && evidenceRefs.includes(sourceContentHash));
  const declaredSourceHashMatchesActual =
    !declaredSourceContentHash
    || (
      contentAddressedSha256(declaredSourceContentHash)
      && sourceContentHash
      && declaredSourceContentHash.toLowerCase() === sourceContentHash.toLowerCase()
    );
  const deterministicVisualModeHashBoundToEvidenceRefs =
    !deterministicVisualModeHash
    || (
      contentAddressedSha256(deterministicVisualModeHash)
      && evidenceRefs.includes(deterministicVisualModeHash)
    );
  const visualProofHashBoundToEvidenceRefs =
    !visualProofHash
    || (contentAddressedSha256(visualProofHash) && evidenceRefs.includes(visualProofHash));
  const visualSceneManifestHashBoundToEvidenceRefs =
    !visualSceneManifestHash
    || (
      contentAddressedSha256(visualSceneManifestHash)
      && evidenceRefs.includes(visualSceneManifestHash)
      && evidenceRefSet.has(visualSceneManifestHash)
    );
  const failedGates = compactStringList([
    profileIdBoundToRow ? null : 'validation_profile_id_not_bound_to_runtime_identity',
    proofIdsBoundToRow ? null : 'validation_profile_proof_ids_not_bound_to_row',
    evidenceRefsBoundToRow ? null : 'validation_profile_evidence_refs_not_bound_to_row',
    profileHashBoundToEvidenceRefs ? null : 'validation_profile_hash_not_bound_to_evidence_refs',
    sourceContentHashBoundToEvidenceRefs ? null : 'validation_profile_source_hash_not_bound_to_evidence_refs',
    declaredSourceHashMatchesActual ? null : 'validation_profile_source_hash_mismatch',
    deterministicVisualModeHashBoundToEvidenceRefs
      ? null
      : 'validation_profile_deterministic_mode_hash_not_bound_to_evidence_refs',
    visualProofHashBoundToEvidenceRefs ? null : 'validation_profile_visual_proof_hash_not_bound_to_evidence_refs',
    visualSceneManifestHashBoundToEvidenceRefs
      ? null
      : 'validation_profile_visual_scene_manifest_hash_not_bound_to_evidence_refs',
  ]);
  return {
    accepted: failedGates.length === 0,
    profileIdBoundToRow,
    profile_id_bound_to_row: profileIdBoundToRow,
    proofIdsBoundToRow,
    proof_ids_bound_to_row: proofIdsBoundToRow,
    evidenceRefsBoundToRow,
    evidence_refs_bound_to_row: evidenceRefsBoundToRow,
    profileHashBoundToEvidenceRefs,
    profile_hash_bound_to_evidence_refs: profileHashBoundToEvidenceRefs,
    sourceContentHashBoundToEvidenceRefs,
    source_content_hash_bound_to_evidence_refs: sourceContentHashBoundToEvidenceRefs,
    declaredSourceHashMatchesActual,
    declared_source_hash_matches_actual: declaredSourceHashMatchesActual,
    deterministicVisualModeHashBoundToEvidenceRefs,
    deterministic_visual_mode_hash_bound_to_evidence_refs: deterministicVisualModeHashBoundToEvidenceRefs,
    visualProofHashBoundToEvidenceRefs,
    visual_proof_hash_bound_to_evidence_refs: visualProofHashBoundToEvidenceRefs,
    visualSceneManifestHashBoundToEvidenceRefs,
    visual_scene_manifest_hash_bound_to_evidence_refs: visualSceneManifestHashBoundToEvidenceRefs,
    evidenceRefsBound,
    evidence_refs_bound: evidenceRefsBound,
    rowProofIdCount: rowProofIds.size,
    row_proof_id_count: rowProofIds.size,
    failedGates,
    failed_gates: failedGates,
  };
}

function validationProfileEvidenceFacet(row = {}) {
  const supplied = rawValidationProfileEvidence(row);
  const schemaVersion = firstText(supplied.schemaVersion, supplied.schema);
  const profileId = firstText(
    supplied.profileId,
    supplied.profile_id,
    supplied.id,
  );
  const profileClass = firstText(
    supplied.profileClass,
    supplied.profile_class,
    supplied.requirementId,
    supplied.requirement_id,
    supplied.coverageId,
    supplied.coverage_id,
  );
  const source = firstText(supplied.source, supplied.evidenceSource, supplied.evidence_source);
  const profileHash = firstText(supplied.profileHash, supplied.profile_hash);
  const sourceContentHash = firstText(
    supplied.sourceContentHash,
    supplied.source_content_hash,
    supplied.sourceHash,
    supplied.source_hash,
  );
  const declaredSourceContentHash = firstText(
    supplied.declaredSourceContentHash,
    supplied.declared_source_content_hash,
  );
  const deterministicVisualModeHash = firstText(
    supplied.deterministicVisualModeHash,
    supplied.deterministic_visual_mode_hash,
  );
  const visualProofHash = firstText(supplied.visualProofHash, supplied.visual_proof_hash);
  const visualSceneManifestHash = firstText(
    supplied.visualSceneManifestHash,
    supplied.visual_scene_manifest_hash,
    supplied.renderSceneManifestHash,
    supplied.render_scene_manifest_hash,
  );
  const requirement = firstText(supplied.requirement, supplied.description);
  const evidenceRefs = compactStringList(supplied.evidenceRefs ?? supplied.evidence_refs);
  const proofIds = compactStringList(supplied.proofIds ?? supplied.proof_ids);
  const binding = validationProfileEvidenceBindingFacet(row, supplied);
  const acceptedFlag = firstBool(
    supplied.accepted,
    supplied.profileAccepted,
    supplied.profile_accepted,
    supplied.validationProfileAccepted,
    supplied.validation_profile_accepted,
  );
  const failedGates = compactStringList([
    Object.keys(supplied).length > 0 ? null : 'validation_profile_evidence_missing',
    schemaVersion === VALIDATION_PROFILE_EVIDENCE_SCHEMA_VERSION
      ? null
      : 'validation_profile_evidence_schema_missing',
    acceptedFlag === true ? null : 'validation_profile_evidence_not_explicitly_accepted',
    profileId ? null : 'validation_profile_id_missing',
    profileClass ? null : 'validation_profile_requirement_id_missing',
    source ? null : 'validation_profile_evidence_source_missing',
    VALIDATION_PROFILE_EVIDENCE_SOURCES.has(source)
      ? null
      : 'validation_profile_evidence_source_not_authorized',
    evidenceRefs.length > 0 || proofIds.length > 0
      ? null
      : 'validation_profile_evidence_refs_missing',
    ...binding.failedGates,
  ]);
  return {
    present: Object.keys(supplied).length > 0,
    accepted: failedGates.length === 0,
    schemaVersion,
    schema_version: schemaVersion,
    profileId,
    profile_id: profileId,
    profileClass,
    profile_class: profileClass,
    requirement,
    source,
    profileHash,
    profile_hash: profileHash,
    sourceContentHash,
    source_content_hash: sourceContentHash,
    declaredSourceContentHash,
    declared_source_content_hash: declaredSourceContentHash,
    deterministicVisualModeHash,
    deterministic_visual_mode_hash: deterministicVisualModeHash,
    visualProofHash,
    visual_proof_hash: visualProofHash,
    visualSceneManifestHash,
    visual_scene_manifest_hash: visualSceneManifestHash,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    proofIds,
    proof_ids: proofIds,
    binding,
    failedGates,
    failed_gates: failedGates,
  };
}

function validationProfileCoverageEntries(rows) {
  const rowsByProfileClass = new Map();
  for (const row of acceptedRows(rows, (candidate) => {
    const evidence = compactObject(candidate.validationProfileEvidence ?? candidate.validation_profile_evidence);
    return evidence.accepted === true
      && Boolean(evidence.profileClass ?? evidence.profile_class)
      && Boolean(evidence.profileId ?? evidence.profile_id)
      && rowHasAcceptedVisualEvidence(candidate);
  })) {
    const evidence = compactObject(row.validationProfileEvidence ?? row.validation_profile_evidence);
    const profileClass = firstText(evidence.profileClass, evidence.profile_class);
    if (!profileClass) continue;
    if (!rowsByProfileClass.has(profileClass)) rowsByProfileClass.set(profileClass, []);
    rowsByProfileClass.get(profileClass).push(row);
  }
  return [...rowsByProfileClass.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([profileClass, profileRows]) => {
      const firstEvidence = compactObject(
        profileRows[0]?.validationProfileEvidence
        ?? profileRows[0]?.validation_profile_evidence,
      );
      const profileId = firstText(firstEvidence.profileId, firstEvidence.profile_id);
      return coverageEntry({
        id: profileClass,
        requirement: firstText(
          firstEvidence.requirement,
          firstEvidence.description,
          `Declared validation profile ${profileClass}`,
        ),
        status: 'accepted',
        rows: profileRows,
        profileId,
        profile_id: profileId,
      });
    });
}

function ledgerRecordForRow(row = {}) {
  return compactObject(row.ledger?.record ?? row.proofLedger?.records?.[0] ?? row.proof_ledger?.records?.[0]);
}

function fullRuntimeCoverageIdentity(row = {}) {
  const record = ledgerRecordForRow(row);
  const chain = compactObject(row.realRocmRuntimeChain ?? row.real_rocm_runtime_chain);
  const proofIds = compactStringList([
    ...(Array.isArray(row.proofIds) ? row.proofIds : []),
    ...(Array.isArray(row.proof_ids) ? row.proof_ids : []),
    row.ledger?.proofId,
    row.ledger?.proof_id,
    record.proofId,
    record.proof_id,
  ]);
  const contractHash = firstText(
    row.contractHash,
    row.contract_hash,
    record.contractHash,
    record.contract_hash,
  );
  const artifactAfterHash = firstText(
    row.artifactAfterHash,
    row.artifact_after_hash,
    row.artifactHash,
    row.artifact_hash,
    record.artifactAfterHash,
    record.artifact_after_hash,
    chain.artifactHash,
    chain.artifact_hash,
  );
  return {
    accepted: proofIds.length > 0
      && contentAddressedSha256(contractHash)
      && contentAddressedArtifactHash(artifactAfterHash),
    proofIds,
    proof_ids: proofIds,
    contractHash,
    contract_hash: contractHash,
    artifactAfterHash,
    artifact_after_hash: artifactAfterHash,
  };
}

function rawRunModeCoverageSupport(row = {}) {
  const runMode = compactObject(row.runMode ?? row.run_mode);
  return compactObject(
    row.runModeCoverageSupport
      ?? row.run_mode_coverage_support
      ?? row.coverageSupport
      ?? row.coverage_support
      ?? runMode.coverageSupport
      ?? runMode.coverage_support,
  );
}

function runModeCoverageSupportFacet(row = {}) {
  const supplied = rawRunModeCoverageSupport(row);
  const parentProofIds = compactStringList([
    ...(Array.isArray(supplied.parentProofIds) ? supplied.parentProofIds : []),
    ...(Array.isArray(supplied.parent_proof_ids) ? supplied.parent_proof_ids : []),
    ...(Array.isArray(supplied.supportedProofIds) ? supplied.supportedProofIds : []),
    ...(Array.isArray(supplied.supported_proof_ids) ? supplied.supported_proof_ids : []),
    ...(Array.isArray(supplied.fullRuntimeProofIds) ? supplied.fullRuntimeProofIds : []),
    ...(Array.isArray(supplied.full_runtime_proof_ids) ? supplied.full_runtime_proof_ids : []),
  ]);
  const contractHash = firstText(supplied.contractHash, supplied.contract_hash);
  const artifactAfterHash = firstText(
    supplied.artifactAfterHash,
    supplied.artifact_after_hash,
    supplied.artifactHash,
    supplied.artifact_hash,
  );
  const failedGates = compactStringList([
    parentProofIds.length > 0 ? null : 'run_mode_support_parent_proof_id_missing',
    contentAddressedSha256(contractHash) ? null : 'run_mode_support_contract_hash_missing_or_not_content_addressed',
    contentAddressedArtifactHash(artifactAfterHash) ? null : 'run_mode_support_artifact_hash_missing_or_not_content_addressed',
  ]);
  return {
    present: Object.keys(supplied).length > 0,
    accepted: failedGates.length === 0,
    parentProofIds,
    parent_proof_ids: parentProofIds,
    contractHash,
    contract_hash: contractHash,
    artifactAfterHash,
    artifact_after_hash: artifactAfterHash,
    failedGates,
    failed_gates: failedGates,
  };
}

function rowHasLinkedRunModeCoverageSupport(row, fullRuntimeRows) {
  const support = compactObject(row.runModeCoverageSupport ?? row.run_mode_coverage_support);
  if (support.accepted !== true) return false;
  const supportParentProofIds = compactStringList(support.parentProofIds ?? support.parent_proof_ids);
  const supportContractHash = firstText(support.contractHash, support.contract_hash);
  const supportArtifactAfterHash = firstText(support.artifactAfterHash, support.artifact_after_hash);
  const normalizedSupportArtifactAfterHash = normalizedArtifactHash(supportArtifactAfterHash);
  return fullRuntimeRows.some((fullRuntimeRow) => {
    const identity = fullRuntimeCoverageIdentity(fullRuntimeRow);
    if (identity.accepted !== true) return false;
    return supportContractHash === identity.contractHash
      && normalizedSupportArtifactAfterHash !== null
      && normalizedSupportArtifactAfterHash === normalizedArtifactHash(identity.artifactAfterHash)
      && supportParentProofIds.some((proofId) => identity.proofIds.includes(proofId));
  });
}

function targetKeyForCoverageRow(row = {}) {
  return `${row.backend}:${row.targetId}`;
}

function appendTargetRow(rowsByTarget, row) {
  const key = targetKeyForCoverageRow(row);
  rowsByTarget.set(key, [...(rowsByTarget.get(key) ?? []), row]);
}

function attachLinkedRunModeSupportRows({ rowsByTarget, fullRuntimeRowsByTarget, supportRows }) {
  const attachedRows = [];
  const unlinkedRows = [];
  for (const row of supportRows) {
    const key = targetKeyForCoverageRow(row);
    const targetFullRuntimeRows = fullRuntimeRowsByTarget.get(key) ?? [];
    if (targetFullRuntimeRows.length === 0) continue;
    if (!rowHasLinkedRunModeCoverageSupport(row, targetFullRuntimeRows)) {
      unlinkedRows.push(row);
      continue;
    }
    appendTargetRow(rowsByTarget, row);
    attachedRows.push(row);
  }
  return { attachedRows, unlinkedRows };
}

function broadLibraryAgnosticScopeProven(_row = {}) {
  // Broad acceptance is a matrix-level generalization claim. A single row, even
  // with a broad-looking facet, cannot authorize it.
  return false;
}

function inferFullRuntimeAcceptanceScope(row) {
  const declaredScope = firstText(row.acceptanceScope, row.acceptance_scope);
  if (declaredScope === BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE) {
    return broadLibraryAgnosticScopeProven(row)
      ? BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE
      : 'broad_library_agnostic_unproven';
  }
  if (declaredScope) return declaredScope;
  if (row.matrixOutcome !== 'full_runtime_gpu_hmr') return 'not_full_runtime';
  if (
    row.acceptanceClass === 'scoped_hip_module_runtime_hmr'
    || row.proofMode === 'hip_module_runtime_readback'
    || row.claimBoundary?.broadHipApplicationAcceptance === false
    || row.claim_boundary?.broadHipApplicationAcceptance === false
    || row.claim_boundary?.broad_hip_application_acceptance === false
  ) {
    return 'hip_module_declared_compute_readback';
  }
  if (row.backend === 'webgpu' && row.proofMode === 'webgpu_wgsl_runtime_compute') {
    return 'webgpu_declared_compute_readback';
  }
  if (row.backend === 'webgpu') {
    return 'webgpu_declared_pipeline_visual';
  }
  if (row.backend === 'hiprt') {
    return 'hiprt_declared_visual_profile';
  }
  if (row.backend === 'hip' && row.proofMode === 'run_mode_proof') {
    return 'generated_rocm_hip_preview_visual';
  }
  if (
    row.backend === 'hip'
    && (
      row.proofMode === 'strict_runtime_ledger'
      || row.proofMode === 'real_rocm_repo_validation'
    )
  ) {
    return 'rocm_hip_declared_runtime_profile';
  }
  return 'declared_profile_scoped';
}

function claimScopeForAcceptanceScope(scope) {
  if (scope === BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE) {
    return BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE;
  }
  if (SCOPED_FULL_RUNTIME_ACCEPTANCE_SCOPES.has(scope)) return 'scoped_profile';
  if (scope === 'not_full_runtime') return 'not_full_runtime';
  return 'unknown_scope';
}

function declaredScopeEvidenceFacet({
  supportedPipelineScope,
  contract = {},
  backendContract = {},
  profile = {},
  claimBoundary = {},
  requireScopedClaimBoundary = false,
} = {}) {
  const artifactIdentity = compactObject(contract.artifact_identity ?? contract.artifactIdentity);
  const scopeEvidenceSources = [
    ['backend_contract.supported_pipeline_scope', backendContract.supported_pipeline_scope],
    ['backend_contract.supportedPipelineScope', backendContract.supportedPipelineScope],
    ['artifact_identity.supported_pipeline_scope', artifactIdentity.supported_pipeline_scope],
    ['artifact_identity.supportedPipelineScope', artifactIdentity.supportedPipelineScope],
    ['profile.validationScope', profile.validationScope],
    ['profile.validation_scope', profile.validation_scope],
    ['profile.pipeline.scope', profile.pipeline?.scope],
    ['profile.pipeline.supportedPipelineScope', profile.pipeline?.supportedPipelineScope],
    ['profile.pipeline.supported_pipeline_scope', profile.pipeline?.supported_pipeline_scope],
    ['claim_boundary.acceptedScope', claimBoundary.acceptedScope],
    ['claim_boundary.accepted_scope', claimBoundary.accepted_scope],
  ]
    .map(([source, value]) => ({ source, value: firstText(value) }))
    .filter((item) => item.value);
  const scope = firstText(
    supportedPipelineScope,
    backendContract.supported_pipeline_scope,
    backendContract.supportedPipelineScope,
    artifactIdentity.supported_pipeline_scope,
    artifactIdentity.supportedPipelineScope,
    profile.validationScope,
    profile.validation_scope,
    profile.pipeline?.scope,
    profile.pipeline?.supportedPipelineScope,
    profile.pipeline?.supported_pipeline_scope,
    claimBoundary.acceptedScope,
    claimBoundary.accepted_scope,
  );
  const observedScopes = scopeEvidenceSources.map((item) => item.value);
  const distinctScopes = [...new Set(observedScopes)];
  const arbitraryTargetAccepted = firstBool(
    claimBoundary.arbitraryTargetRuntimeAccepted,
    claimBoundary.arbitrary_target_runtime_accepted,
  );
  const arbitraryLibraryAccepted = firstBool(
    claimBoundary.arbitraryLibraryAccepted,
    claimBoundary.arbitrary_library_accepted,
  );
  const broadApplicationAccepted = firstBool(
    claimBoundary.broadHipApplicationAcceptance,
    claimBoundary.broad_hip_application_acceptance,
    claimBoundary.broadApplicationAcceptance,
    claimBoundary.broad_application_acceptance,
  );
  const broadAcceptanceClaimed =
    arbitraryTargetAccepted === true
    || arbitraryLibraryAccepted === true
    || broadApplicationAccepted === true
    || scope === 'broad_library_agnostic';
  const claimBoundaryPresent = Object.keys(claimBoundary).length > 0;
  const scopedClaimBoundaryAccepted = !requireScopedClaimBoundary || (
    claimBoundaryPresent
    && Boolean(firstText(claimBoundary.proofAuthority, claimBoundary.proof_authority))
    && Boolean(firstText(claimBoundary.executionBoundary, claimBoundary.execution_boundary))
    && firstText(claimBoundary.acceptedScope, claimBoundary.accepted_scope) === scope
    && arbitraryTargetAccepted === false
    && arbitraryLibraryAccepted === false
    && broadApplicationAccepted === false
    && compactStringList(
      claimBoundary.unsupportedWithoutEvidence
      ?? claimBoundary.unsupported_without_evidence
    ).length > 0
  );
  const accepted =
    Boolean(scope)
    && observedScopes.length >= 2
    && distinctScopes.length === 1
    && broadAcceptanceClaimed === false
    && scopedClaimBoundaryAccepted === true;
  return {
    accepted,
    scope,
    scopeEvidenceSources,
    scope_evidence_sources: scopeEvidenceSources,
    observedScopes,
    observed_scopes: observedScopes,
    distinctScopes,
    distinct_scopes: distinctScopes,
    broadAcceptanceClaimed,
    broad_acceptance_claimed: broadAcceptanceClaimed,
    scopedClaimBoundaryAccepted,
    scoped_claim_boundary_accepted: scopedClaimBoundaryAccepted,
    failedGates: compactStringList([
      scope ? null : 'declared_supported_scope_missing',
      scopeEvidenceSources.length >= 2 ? null : 'declared_supported_scope_requires_multiple_evidence_sources',
      distinctScopes.length === 1 ? null : 'declared_supported_scope_mismatch',
      broadAcceptanceClaimed === false ? null : 'declared_supported_scope_claims_broad_acceptance',
      scopedClaimBoundaryAccepted === true ? null : 'declared_supported_scope_claim_boundary_not_proven',
    ]),
  };
}

function runtimeProbeInstrumentationDisclosureFacet(...sources) {
  const disclosure = compactObject(sources.find((source) => Object.keys(compactObject(source)).length > 0));
  const sourceAdaptations = compactStringList(
    disclosure.sourceAdaptations
    ?? disclosure.source_adaptations
  );
  const scope = firstText(
    disclosure.acceptanceScope,
    disclosure.acceptance_scope,
    disclosure.acceptedScope,
    disclosure.accepted_scope,
  );
  const arbitraryTargetAccepted = firstBool(
    disclosure.arbitraryTargetRuntimeAccepted,
    disclosure.arbitrary_target_runtime_accepted,
  );
  const arbitraryLibraryAccepted = firstBool(
    disclosure.arbitraryLibraryAccepted,
    disclosure.arbitrary_library_accepted,
  );
  const broadApplicationAccepted = firstBool(
    disclosure.broadApplicationAcceptance,
    disclosure.broad_application_acceptance,
    disclosure.broadHipApplicationAcceptance,
    disclosure.broad_hip_application_acceptance,
  );
  const adaptedOrAlreadyPresent = firstBool(
    disclosure.adaptedOrAlreadyPresent,
    disclosure.adapted_or_already_present,
  );
  const present = Object.keys(disclosure).length > 0;
  const accepted =
    present
    && disclosure.accepted === true
    && firstText(disclosure.kind) === 'declared_profile_probe_instrumentation'
    && firstText(disclosure.instrumentationKind, disclosure.instrumentation_kind) === 'profile_probe_instrumentation'
    && Boolean(firstText(disclosure.adapterFamily, disclosure.adapter_family))
    && Boolean(firstText(disclosure.proofAuthority, disclosure.proof_authority))
    && Boolean(firstText(disclosure.executionBoundary, disclosure.execution_boundary))
    && scope === 'hiprt_declared_visual_profile'
    && sourceAdaptations.length > 0
    && adaptedOrAlreadyPresent === true
    && arbitraryTargetAccepted === false
    && arbitraryLibraryAccepted === false
    && broadApplicationAccepted === false
    && compactStringList(
      disclosure.unsupportedWithoutEvidence
      ?? disclosure.unsupported_without_evidence
    ).length > 0;
  return {
    present,
    accepted,
    disclosure,
    sourceAdaptations,
    source_adaptations: sourceAdaptations,
    scope,
    adaptedOrAlreadyPresent,
    adapted_or_already_present: adaptedOrAlreadyPresent,
    arbitraryTargetAccepted,
    arbitrary_target_accepted: arbitraryTargetAccepted,
    arbitraryLibraryAccepted,
    arbitrary_library_accepted: arbitraryLibraryAccepted,
    broadApplicationAccepted,
    broad_application_accepted: broadApplicationAccepted,
    failedGates: compactStringList([
      present ? null : 'runtime_probe_instrumentation_disclosure_missing',
      disclosure.accepted === true ? null : 'runtime_probe_instrumentation_disclosure_not_accepted',
      firstText(disclosure.kind) === 'declared_profile_probe_instrumentation'
        ? null
        : 'runtime_probe_instrumentation_kind_not_declared',
      firstText(disclosure.instrumentationKind, disclosure.instrumentation_kind) === 'profile_probe_instrumentation'
        ? null
        : 'runtime_probe_instrumentation_type_not_profile_probe',
      firstText(disclosure.adapterFamily, disclosure.adapter_family)
        ? null
        : 'runtime_probe_instrumentation_adapter_family_missing',
      firstText(disclosure.proofAuthority, disclosure.proof_authority)
        ? null
        : 'runtime_probe_instrumentation_authority_missing',
      firstText(disclosure.executionBoundary, disclosure.execution_boundary)
        ? null
        : 'runtime_probe_instrumentation_execution_boundary_missing',
      scope === 'hiprt_declared_visual_profile'
        ? null
        : 'runtime_probe_instrumentation_scope_not_hiprt_declared_visual_profile',
      sourceAdaptations.length > 0 ? null : 'runtime_probe_source_adaptations_missing',
      adaptedOrAlreadyPresent === true ? null : 'runtime_probe_source_adaptations_not_applied',
      arbitraryTargetAccepted === false ? null : 'runtime_probe_claims_arbitrary_target_acceptance',
      arbitraryLibraryAccepted === false ? null : 'runtime_probe_claims_arbitrary_library_acceptance',
      broadApplicationAccepted === false ? null : 'runtime_probe_claims_broad_application_acceptance',
      compactStringList(disclosure.unsupportedWithoutEvidence ?? disclosure.unsupported_without_evidence).length > 0
        ? null
        : 'runtime_probe_unsupported_without_evidence_missing',
    ]),
  };
}

function objectsForSourceAdaptationFacet(...sources) {
  const direct = sources.flatMap((source) => {
    if (Array.isArray(source)) return source.map(compactObject);
    return [compactObject(source)];
  }).filter((source) => Object.keys(source).length > 0);
  const nested = direct.flatMap((source) => [
    compactObject(source.runtimeProbeInstrumentation ?? source.runtime_probe_instrumentation),
    compactObject(source.runtimeProofArtifact ?? source.runtime_proof_artifact),
    compactObject(source.sourceAdaptation ?? source.source_adaptation),
    compactObject(source.derivedProofLedgerRecord ?? source.derived_proof_ledger_record),
    compactObject(source.proofLedger?.records?.[0] ?? source.proof_ledger?.records?.[0]),
    ...compactObjectList(source.outputOracleAdaptations ?? source.output_oracle_adaptations),
    ...compactObjectList(source.records),
    ...compactObjectList(source.limitations),
    ...compactObjectList(source.failedGates ?? source.failed_gates),
  ]);
  return [...direct, ...nested].filter((source) => Object.keys(source).length > 0);
}

function sourceAdaptationProofFacet(...sources) {
  const objects = objectsForSourceAdaptationFacet(...sources);
  const sourceAdaptations = compactStringList(objects.flatMap((source) => [
    ...(Array.isArray(source.sourceAdaptations) ? source.sourceAdaptations : []),
    ...(Array.isArray(source.source_adaptations) ? source.source_adaptations : []),
    /^source_derived_/i.test(firstText(source.kind) ?? '')
      ? `source-derived-output-oracle:${firstText(source.profileId, source.profile_id, source.oracleId, source.oracle_id) ?? 'unknown'}`
      : null,
  ]));
  const adaptedFlags = objects
    .map((source) => firstBool(
      source.sourceAdaptedProfile,
      source.source_adapted_profile,
      source.adaptedOrAlreadyPresent,
      source.adapted_or_already_present,
    ))
    .filter((value) => value !== null);
  const limitationCodes = compactStringList(objects.flatMap((source) => [
    source.code,
    source.reason,
    source.degradedReason,
    source.degraded_reason,
    ...(Array.isArray(source.limitations)
      ? source.limitations.map((item) => (
          isObject(item)
            ? firstText(item.code, item.reason, item.degradedReason, item.degraded_reason)
            : item
        ))
      : []),
  ]));
  const sourceAdaptedProfile =
    sourceAdaptations.length > 0
    || adaptedFlags.includes(true)
    || limitationCodes.includes('source_adapted_profile_not_no_shim_gpu_hmr');
  return {
    present: objects.length > 0,
    acceptedForNoShimHmr: sourceAdaptedProfile === false,
    accepted_for_no_shim_hmr: sourceAdaptedProfile === false,
    sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptedProfile,
    sourceAdaptations,
    source_adaptations: sourceAdaptations,
    adaptedFlags,
    adapted_flags: adaptedFlags,
    limitationCodes,
    limitation_codes: limitationCodes,
    failedGates: sourceAdaptedProfile
      ? [{ code: 'source_adapted_profile_not_no_shim_gpu_hmr' }]
      : [],
    failed_gates: sourceAdaptedProfile
      ? [{ code: 'source_adapted_profile_not_no_shim_gpu_hmr' }]
      : [],
  };
}

function eventArtifactHash(event = {}) {
  return firstText(
    event.artifactHash,
    event.artifact_hash,
    event.artifactId,
    event.artifact_id,
  );
}

function artifactHashesForNoShimIdentity(row = {}) {
  const record = ledgerRecordForRow(row);
  const contract = compactObject(row.acceptanceContract ?? row.acceptance_contract);
  const fissionReport = compactObject(
    row.fissionReport
    ?? row.fission_report
    ?? contract.fissionReport
    ?? contract.fission_report,
  );
  const hashes = compactStringList([
    row.artifactAfterHash,
    row.artifact_after_hash,
    row.artifactHash,
    row.artifact_hash,
    record.artifactAfterHash,
    record.artifact_after_hash,
    contract.artifact_hash_after,
    contract.artifactHashAfter,
    fissionReport.artifact_hash_after,
    fissionReport.artifactHashAfter,
    eventArtifactHash(record.loaderEvent ?? record.loader_event),
    eventArtifactHash(record.epochPublishEvent ?? record.epoch_publish_event),
    eventArtifactHash(record.dispatchEvent ?? record.dispatch_event),
    eventArtifactHash(record.outputEvent ?? record.output_event),
  ]);
  return {
    raw: hashes,
    normalized: compactStringList(hashes.map(normalizedArtifactHash)),
  };
}

function sourceDeltaExecutionIdentity(sourceDeltaExecution = {}) {
  const phases = compactObjectList(sourceDeltaExecution.phases);
  return {
    editHashes: compactStringList(phases.map((phase) => firstText(phase.editHash, phase.edit_hash))),
    beforeHashes: compactStringList(phases.map((phase) => firstText(
      phase.sourceBeforeHash,
      phase.source_before_hash,
      phase.beforeHash,
      phase.before_hash,
    ))),
    afterHashes: compactStringList(phases.map((phase) => firstText(
      phase.sourceAfterHash,
      phase.source_after_hash,
      phase.afterHash,
      phase.after_hash,
    ))),
    changedSources: compactStringList(phases.map((phase) => firstText(
      phase.file,
      phase.path,
      phase.sourcePath,
      phase.source_path,
    ))),
    sourceWriteObserved: phases.some((phase) => firstBool(
      phase.sourceWriteObserved,
      phase.source_write_observed,
    ) === true),
  };
}

function noShimSourceIdentityFacet(row = {}) {
  const record = ledgerRecordForRow(row);
  const runMode = compactObject(row.runMode ?? row.run_mode);
  const timings = compactObject(row.timings);
  const timingMetrics = compactObject(timings.timingMetrics ?? timings.timing_metrics);
  const runtimeProofArtifact = compactObject(row.runtimeProofArtifact ?? row.runtime_proof_artifact);
  const contract = compactObject(row.acceptanceContract ?? row.acceptance_contract);
  const artifactIdentity = compactObject(contract.artifactIdentity ?? contract.artifact_identity);
  const fissionReport = compactObject(
    row.fissionReport
    ?? row.fission_report
    ?? contract.fissionReport
    ?? contract.fission_report,
  );
  const sourceDeltaIdentity = sourceDeltaExecutionIdentity(compactObject(
    row.realRocmSourceDeltaExecution
    ?? row.real_rocm_source_delta_execution
    ?? row.sourceDeltaExecution
    ?? row.source_delta_execution,
  ));
  const sourceAdaptation = sourceAdaptationProofFacet(row);
  const artifactHashes = artifactHashesForNoShimIdentity(row);
  const runtimeEventHashes = [
    eventArtifactHash(record.loaderEvent ?? record.loader_event),
    eventArtifactHash(record.epochPublishEvent ?? record.epoch_publish_event),
    eventArtifactHash(record.dispatchEvent ?? record.dispatch_event),
    eventArtifactHash(record.outputEvent ?? record.output_event),
  ].map(normalizedArtifactHash).filter(Boolean);
  const artifactAfterHash = firstText(
    normalizedArtifactHash(row.artifactAfterHash),
    normalizedArtifactHash(row.artifact_after_hash),
    normalizedArtifactHash(record.artifactAfterHash),
    normalizedArtifactHash(record.artifact_after_hash),
    normalizedArtifactHash(contract.artifact_hash_after),
    normalizedArtifactHash(contract.artifactHashAfter),
    normalizedArtifactHash(fissionReport.artifact_hash_after),
    normalizedArtifactHash(fissionReport.artifactHashAfter),
    artifactHashes.normalized[0],
  );
  const runtimeArtifactChainClosed =
    Boolean(artifactAfterHash)
    && runtimeEventHashes.length >= 3
    && runtimeEventHashes.every((hash) => hash === artifactAfterHash);
  const editHashes = compactStringList([
    row.editHash,
    row.edit_hash,
    runMode.editHash,
    runMode.edit_hash,
    timingMetrics.editHash,
    timingMetrics.edit_hash,
    ...sourceDeltaIdentity.editHashes,
  ]);
  const contentAddressedEditHashes = editHashes.filter(contentAddressedSha256);
  const beforeSourceHashes = sourceDeltaIdentity.beforeHashes.filter(contentAddressedSha256);
  const afterSourceHashes = sourceDeltaIdentity.afterHashes.filter(contentAddressedSha256);
  const sourceHashes = compactStringList([
    ...beforeSourceHashes,
    ...afterSourceHashes,
  ]);
  const changedSources = compactStringList([
    ...sourceDeltaIdentity.changedSources,
    ...(Array.isArray(fissionReport.changedSources) ? fissionReport.changedSources : []),
    ...(Array.isArray(fissionReport.changed_sources) ? fissionReport.changed_sources : []),
    ...(Array.isArray(artifactIdentity.sourcePaths) ? artifactIdentity.sourcePaths : []),
    ...(Array.isArray(artifactIdentity.source_paths) ? artifactIdentity.source_paths : []),
  ]);
  const proofIds = compactStringList([
    ...(Array.isArray(row.proofIds) ? row.proofIds : []),
    ...(Array.isArray(row.proof_ids) ? row.proof_ids : []),
    row.ledger?.proofId,
    row.ledger?.proof_id,
    record.proofId,
    record.proof_id,
    runtimeProofArtifact.proofId,
    runtimeProofArtifact.proof_id,
  ]);
  const evidenceRefs = compactStringList([
    ...rowEvidenceRefs(row),
    ...evidenceRefsFromValue(contract),
    ...evidenceRefsFromValue(fissionReport),
  ]);
  const sourceIdentityObserved =
    changedSources.length > 0
    || sourceDeltaIdentity.sourceWriteObserved === true;
  const contentAddressedSourceIdentityPresent =
    contentAddressedEditHashes.length > 0
    || (beforeSourceHashes.length > 0 && afterSourceHashes.length > 0);
  const failedGates = compactStringList([
    sourceAdaptation.acceptedForNoShimHmr === true
      ? null
      : 'no_shim_source_identity_source_adaptation_detected',
    contentAddressedSourceIdentityPresent ? null : 'no_shim_source_identity_source_or_edit_hash_missing',
    artifactAfterHash ? null : 'no_shim_source_identity_artifact_after_hash_missing',
    runtimeArtifactChainClosed ? null : 'no_shim_source_identity_runtime_artifact_chain_unclosed',
    proofIds.length > 0 ? null : 'no_shim_source_identity_runtime_proof_binding_missing',
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.no_shim_source_identity.v1',
    schema_version: 'synthi.gpu_hmr.no_shim_source_identity.v1',
    authority: 'matrix_recomputed_from_ledger_runtime_and_source_identity',
    accepted: failedGates.length === 0,
    sourceIdentityPresent: contentAddressedSourceIdentityPresent,
    source_identity_present: contentAddressedSourceIdentityPresent,
    contentAddressedSourceIdentityPresent,
    content_addressed_source_identity_present: contentAddressedSourceIdentityPresent,
    sourceIdentityObserved,
    source_identity_observed: sourceIdentityObserved,
    runtimeArtifactChainClosed,
    runtime_artifact_chain_closed: runtimeArtifactChainClosed,
    artifactAfterHash,
    artifact_after_hash: artifactAfterHash,
    contentAddressedEditHashes,
    content_addressed_edit_hashes: contentAddressedEditHashes,
    sourceHashes,
    source_hashes: sourceHashes,
    changedSources,
    changed_sources: changedSources,
    proofIds,
    proof_ids: proofIds,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    sourceAdaptedProfile: sourceAdaptation.sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptation.sourceAdaptedProfile,
    failedGates: failedGates.map((code) => ({ code })),
    failed_gates: failedGates.map((code) => ({ code })),
  };
}

function generalityClaimFacet(row = {}) {
  const acceptanceScope = firstText(row.acceptanceScope, row.acceptance_scope) ?? inferFullRuntimeAcceptanceScope(row);
  const claimScope = firstText(row.claimScope, row.claim_scope) ?? claimScopeForAcceptanceScope(acceptanceScope);
  const broadAccepted =
    claimScope === BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE
    && acceptanceScope === BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE
    && broadLibraryAgnosticScopeProven(row) === true;
  const profileScopedOnly = claimScope === 'scoped_profile';
  const unsupportedWithoutEvidence = broadAccepted
    ? []
    : SCOPED_GENERALITY_UNSUPPORTED_WITHOUT_EVIDENCE;
  return {
    schemaVersion: GPU_HMR_GENERALITY_CLAIM_SCHEMA_VERSION,
    authority: 'matrix_computed_from_acceptance_scope',
    acceptanceScope,
    acceptance_scope: acceptanceScope,
    claimScope,
    claim_scope: claimScope,
    profileScopedOnly,
    profile_scoped_only: profileScopedOnly,
    broadLibraryAgnosticAccepted: broadAccepted,
    broad_library_agnostic_accepted: broadAccepted,
    arbitraryLibraryAccepted: broadAccepted,
    arbitrary_library_accepted: broadAccepted,
    arbitraryTargetRuntimeAccepted: broadAccepted,
    arbitrary_target_runtime_accepted: broadAccepted,
    unsupportedWithoutEvidence,
    unsupported_without_evidence: unsupportedWithoutEvidence,
    openGaps: broadAccepted ? [] : ['broad_library_agnostic_proof_not_present'],
    open_gaps: broadAccepted ? [] : ['broad_library_agnostic_proof_not_present'],
    failedGates: [],
    failed_gates: [],
  };
}

function generalityClaimFailures(row) {
  if (row.acceptedForGpuHmr !== true) return [];
  const supplied = compactObject(row.generalityClaim ?? row.generality_claim);
  const expected = generalityClaimFacet(row);
  if (Object.keys(supplied).length === 0) {
    return [{ code: 'gpu_hmr_success_requires_generality_claim_facet' }];
  }
  const suppliedUnsupported = compactStringList(
    supplied.unsupportedWithoutEvidence
    ?? supplied.unsupported_without_evidence,
  );
  const failures = compactStringList([
    firstText(supplied.schemaVersion, supplied.schema_version) === GPU_HMR_GENERALITY_CLAIM_SCHEMA_VERSION
      ? null
      : 'gpu_hmr_generality_claim_schema_mismatch',
    firstText(supplied.authority) === expected.authority
      ? null
      : 'gpu_hmr_generality_claim_authority_mismatch',
    firstText(supplied.acceptanceScope, supplied.acceptance_scope) === expected.acceptanceScope
      ? null
      : 'gpu_hmr_generality_claim_acceptance_scope_mismatch',
    firstText(supplied.claimScope, supplied.claim_scope) === expected.claimScope
      ? null
      : 'gpu_hmr_generality_claim_scope_mismatch',
    firstBool(supplied.profileScopedOnly, supplied.profile_scoped_only) === expected.profileScopedOnly
      ? null
      : 'gpu_hmr_generality_claim_profile_scope_mismatch',
    firstBool(supplied.broadLibraryAgnosticAccepted, supplied.broad_library_agnostic_accepted) === expected.broadLibraryAgnosticAccepted
      ? null
      : 'gpu_hmr_generality_claim_broad_acceptance_mismatch',
    firstBool(supplied.arbitraryLibraryAccepted, supplied.arbitrary_library_accepted) === expected.arbitraryLibraryAccepted
      ? null
      : 'gpu_hmr_generality_claim_arbitrary_library_mismatch',
    firstBool(supplied.arbitraryTargetRuntimeAccepted, supplied.arbitrary_target_runtime_accepted) === expected.arbitraryTargetRuntimeAccepted
      ? null
      : 'gpu_hmr_generality_claim_arbitrary_target_mismatch',
    expected.profileScopedOnly && suppliedUnsupported.length === 0
      ? 'gpu_hmr_generality_claim_requires_unsupported_without_evidence'
      : null,
  ]);
  return failures.map((code) => ({ code }));
}

function realRocmAttemptCompletenessFacet({
  accepted = false,
  upstreamLifecycleFailure = {},
  workerRepoTransferFailure = {},
  proofScheduling = {},
  runtimeProofArtifact = {},
  strictGateFailures = [],
  ledger = {},
} = {}) {
  const upstreamPresent = Object.keys(compactObject(upstreamLifecycleFailure)).length > 0;
  const upstreamAccepted = firstBool(
    upstreamLifecycleFailure.acceptedAsRefusalEvidence,
    upstreamLifecycleFailure.accepted_as_refusal_evidence,
  ) === true;
  const transferPresent = Object.keys(compactObject(workerRepoTransferFailure)).length > 0;
  const transferAccepted = firstBool(
    workerRepoTransferFailure.acceptedAsRefusalEvidence,
    workerRepoTransferFailure.accepted_as_refusal_evidence,
  ) === true;
  const proofSchedulingHasPresentFlag = Object.prototype.hasOwnProperty.call(
    proofScheduling,
    'present',
  );
  const proofSchedulingPresent = proofSchedulingHasPresentFlag
    ? proofScheduling.present === true
    : Object.keys(compactObject(proofScheduling)).length > 0;
  const proofSchedulingAccepted = proofScheduling.present === true
    && proofScheduling.accepted === true
    && firstBool(
      proofScheduling.acceptedAsRefusalEvidence,
      proofScheduling.accepted_as_refusal_evidence,
    ) === true;
  const runtimeProofPresent = runtimeProofArtifact.present === true;
  const ledgerPresent = ledger.present === true;
  const score = accepted
    ? 100
    : upstreamAccepted
      ? 80
      : proofSchedulingAccepted
        ? 80
        : transferAccepted
          ? 70
          : upstreamPresent
            ? 60
            : transferPresent
              ? 50
              : proofSchedulingPresent
                ? 40
                : ledgerPresent && runtimeProofPresent && strictGateFailures.length > 0
                  ? 30
                  : runtimeProofPresent
                    ? 20
                    : ledgerPresent
                      ? 10
                      : 0;
  return {
    accepted: score >= 80,
    score,
    upstreamLifecyclePresent: upstreamPresent,
    upstream_lifecycle_present: upstreamPresent,
    upstreamLifecycleAcceptedAsRefusalEvidence: upstreamAccepted,
    upstream_lifecycle_accepted_as_refusal_evidence: upstreamAccepted,
    workerRepoTransferPresent: transferPresent,
    worker_repo_transfer_present: transferPresent,
    workerRepoTransferAcceptedAsRefusalEvidence: transferAccepted,
    worker_repo_transfer_accepted_as_refusal_evidence: transferAccepted,
    proofSchedulingPresent,
    proof_scheduling_present: proofSchedulingPresent,
    proofSchedulingAcceptedAsRefusalEvidence: proofSchedulingAccepted,
    proof_scheduling_accepted_as_refusal_evidence: proofSchedulingAccepted,
    runtimeProofArtifactPresent: runtimeProofPresent,
    runtime_proof_artifact_present: runtimeProofPresent,
    ledgerPresent,
    ledger_present: ledgerPresent,
    failedGates: compactStringList([
      upstreamAccepted || proofSchedulingAccepted || transferAccepted || accepted
        ? null
        : 'real_rocm_refusal_evidence_not_accepted',
      upstreamPresent || proofSchedulingPresent || transferPresent || accepted
        ? null
        : 'real_rocm_attempt_evidence_missing',
    ]),
  };
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
  row.runModeCoverageSupport = runModeCoverageSupportFacet(row);
  row.run_mode_coverage_support = row.runModeCoverageSupport;
  row.validationProfileEvidence = validationProfileEvidenceFacet(row);
  row.validation_profile_evidence = row.validationProfileEvidence;
  row.declaredAcceptanceScope = firstText(row.acceptanceScope, row.acceptance_scope) ?? null;
  row.declared_acceptance_scope = row.declaredAcceptanceScope;
  row.acceptanceScope = inferFullRuntimeAcceptanceScope(row);
  row.acceptance_scope = row.acceptanceScope;
  row.claimScope = claimScopeForAcceptanceScope(row.acceptanceScope);
  row.claim_scope = row.claimScope;
  if (
    row.matrixOutcome === 'full_runtime_gpu_hmr'
    && row.acceptedForGpuHmr === true
    && row.claimScope === 'unknown_scope'
  ) {
    row.matrixOutcome = 'unproven';
    row.acceptedForGpuHmr = false;
    row.gpuHmrSuccess = false;
    row.proofChainAccepted = false;
    row.acceptanceClass = firstText(row.acceptanceClass, row.acceptance_class)
      ?? 'runtime_proof_rejected';
    row.acceptance_class = row.acceptanceClass;
    row.proofChain = 'acceptance_scope_rejected';
    row.proof_chain = row.proofChain;
    row.reasons = compactStringList([
      ...(Array.isArray(row.reasons) ? row.reasons : []),
      'gpu_hmr_success_requires_known_acceptance_scope',
    ]);
    row.openGaps = compactStringList([
      ...(Array.isArray(row.openGaps) ? row.openGaps : []),
      'gpu_hmr_success_requires_known_acceptance_scope',
    ]);
  }
  const shouldCarryGeneralityClaim =
    row.matrixOutcome === 'full_runtime_gpu_hmr'
    || row.acceptedForGpuHmr === true;
  if (shouldCarryGeneralityClaim) {
    if (!isObject(row.generalityClaim) && !isObject(row.generality_claim)) {
      row.generalityClaim = generalityClaimFacet(row);
    } else if (!isObject(row.generalityClaim)) {
      row.generalityClaim = compactObject(row.generality_claim);
    }
    row.generality_claim = row.generalityClaim;
  }
  row.fullRuntimeEvidenceAuthority = fullRuntimeEvidenceAuthorityFacet(row);
  row.full_runtime_evidence_authority = row.fullRuntimeEvidenceAuthority;
  row.noShimSourceIdentity = noShimSourceIdentityFacet(row);
  row.no_shim_source_identity = row.noShimSourceIdentity;
  const safetyFailures = rowSafetyFailures(row);
  row.safety = {
    accepted: safetyFailures.length === 0,
    failedGates: safetyFailures,
  };
  row.rowId = rowIdFor(row);
  row.matrixKey = rowKey(row);
  row.attemptKey = rowAttemptKey(row);
  return row;
}

function stringListFromFields(object, ...keys) {
  const source = compactObject(object);
  return compactStringList(keys.flatMap((key) => {
    const value = source[key];
    return Array.isArray(value) ? value : [value];
  }));
}

function enumOrText(value) {
  if (isObject(value)) return firstText(value.value);
  return firstText(value);
}

function firewallBoolEvidence(json, firewallEvidence, camelKey, snakeKey) {
  return firstBool(
    json[camelKey],
    json[snakeKey],
    firewallEvidence[camelKey],
    firewallEvidence[snakeKey],
  );
}

function negativeEditRefusalEvidenceFacet(json = {}, { runMode = {}, reasons = [] } = {}) {
  const firewallEvidence = compactObject(json.firewallEvidence ?? json.firewall_evidence);
  const classification = compactObject(
    json.classification
      ?? json.acceptanceContract?.classification
      ?? json.acceptance_contract?.classification
      ?? json.contract?.classification,
  );
  const route = enumOrText(classification.route);
  const blockingGaps = compactStringList([
    ...stringListFromFields(classification, 'blockingGaps', 'blocking_gaps'),
    ...stringListFromFields(json, 'blockingGaps', 'blocking_gaps', 'unsupportedReasons', 'unsupported_reasons'),
  ]);
  const executableStaticCheck = compactObject(
    json.executableStaticCheck
      ?? json.executable_static_check,
  );
  const sourceOccurrenceProof = compactObject(
    json.sourceOccurrenceProof
      ?? json.source_occurrence_proof
      ?? json.sourceProof
      ?? json.source_proof
      ?? json.sourceDeltaProof
      ?? json.source_delta_proof,
  );
  const negativeEditProof = compactObject(
    json.negativeEditProof
      ?? json.negative_edit_proof
      ?? json.negativeEdit
      ?? json.negative_edit
      ?? json.backendNegativeEdit
      ?? json.backend_negative_edit,
  );
  const executableStaticEvidenceAccepted =
    executableStaticCheck.accepted === true
    && (
      executableStaticCheck.signatureChanged === true
      || executableStaticCheck.signature_changed === true
      || Boolean(firstText(executableStaticCheck.sourceAfterHash, executableStaticCheck.source_after_hash))
      || Boolean(firstText(executableStaticCheck.acceptedSignatureHash, executableStaticCheck.accepted_signature_hash))
      || Boolean(firstText(executableStaticCheck.negativeSignatureHash, executableStaticCheck.negative_signature_hash))
      || Boolean(firstText(executableStaticCheck.proofId, executableStaticCheck.proof_id))
    );
  const sourceOccurrenceAccepted =
    sourceOccurrenceProof.accepted === true
    && (
      Boolean(firstText(sourceOccurrenceProof.proofId, sourceOccurrenceProof.proof_id))
      || Boolean(firstText(sourceOccurrenceProof.beforeHash, sourceOccurrenceProof.before_hash))
      || Boolean(firstText(sourceOccurrenceProof.afterHash, sourceOccurrenceProof.after_hash))
      || Number.isFinite(finiteNumber(sourceOccurrenceProof.beforeCount ?? sourceOccurrenceProof.before_count))
      || Number.isFinite(finiteNumber(sourceOccurrenceProof.afterCount ?? sourceOccurrenceProof.after_count))
    );
  const rejectClassificationAccepted =
    route === 'reject'
    && blockingGaps.length > 0;
  const negativeEditProofAccepted =
    negativeEditProof.accepted === true
    && (
      contentAddressedSha256(firstText(negativeEditProof.editHash, negativeEditProof.edit_hash))
      || Boolean(firstText(negativeEditProof.proofId, negativeEditProof.proof_id))
      || Boolean(firstText(negativeEditProof.sourceProofId, negativeEditProof.source_proof_id))
    );
  const typedRefusalModes = compactStringList([
    executableStaticEvidenceAccepted ? 'executable_static_check' : null,
    sourceOccurrenceAccepted ? 'source_occurrence_proof' : null,
    rejectClassificationAccepted ? 'reject_classification_blocking_gaps' : null,
    negativeEditProofAccepted ? 'negative_edit_proof_object' : null,
  ]);
  const cpuHmrUsed = firewallBoolEvidence(json, firewallEvidence, 'cpuHmrUsed', 'cpu_hmr_used');
  const fullRebuildUsed = firewallBoolEvidence(json, firewallEvidence, 'fullRebuildUsed', 'full_rebuild_used');
  const processRestarted = firewallBoolEvidence(json, firewallEvidence, 'processRestarted', 'process_restarted');
  const failedGates = compactStringList([
    json.gpuHmrSuccess === false && json.gpu_hmr_success !== true
      ? null
      : 'negative_edit_gpu_hmr_not_explicitly_false',
    json.acceptedForGpuHmr !== true && json.accepted_for_gpu_hmr !== true
      ? null
      : 'negative_edit_accepted_for_gpu_hmr_true',
    reasons.length > 0 ? null : 'negative_edit_refusal_reasons_missing',
    runMode.accepted === true ? null : 'negative_edit_run_mode_timing_not_accepted',
    runMode.editKind === 'negative_edit' || runMode.differentEdit === true
      ? null
      : 'negative_edit_run_mode_not_negative_or_different',
    contentAddressedSha256(runMode.editHash) ? null : 'negative_edit_hash_missing_or_not_content_addressed',
    cpuHmrUsed === false ? null : 'negative_edit_cpu_hmr_firewall_not_explicitly_false',
    fullRebuildUsed === false ? null : 'negative_edit_full_rebuild_firewall_not_explicitly_false',
    processRestarted === false ? null : 'negative_edit_process_restart_firewall_not_explicitly_false',
    typedRefusalModes.length > 0 ? null : 'negative_edit_structural_refusal_proof_missing',
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.negative_edit_refusal_evidence_facet.v1',
    accepted: failedGates.length === 0,
    typedRefusalModes,
    typed_refusal_modes: typedRefusalModes,
    executableStaticEvidenceAccepted,
    executable_static_evidence_accepted: executableStaticEvidenceAccepted,
    sourceOccurrenceAccepted,
    source_occurrence_accepted: sourceOccurrenceAccepted,
    rejectClassificationAccepted,
    reject_classification_accepted: rejectClassificationAccepted,
    negativeEditProofAccepted,
    negative_edit_proof_accepted: negativeEditProofAccepted,
    cpuHmrUsed,
    cpu_hmr_used: cpuHmrUsed,
    fullRebuildUsed,
    full_rebuild_used: fullRebuildUsed,
    processRestarted,
    process_restarted: processRestarted,
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates,
    failed_gates: failedGates,
  };
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
  const schemaVersion = firstText(contract.schemaVersion, contract.schema_version, contract.schema);
  const stageResults = compactObject(
    contract.stageResults
    ?? contract.stage_results
    ?? contract.stages,
  );
  const directBlockingGaps = compactStringList([
    ...(Array.isArray(contract.blockingGaps) ? contract.blockingGaps : []),
    ...(Array.isArray(contract.blocking_gaps) ? contract.blocking_gaps : []),
  ]);
  const contractHash = firstText(contract.contractHash, contract.contract_hash);
  const stageChecks = Object.fromEntries(REAL_ROCM_APP_HOOK_REQUIRED_STAGES.map((stageName) => {
    const camelStage = stageName.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    const stage = compactObject(
      stageResults[stageName]
      ?? stageResults[camelStage]
      ?? compactObject(contract[stageName])
      ?? compactObject(contract[camelStage]),
    );
    const present = Object.keys(stage).length > 0;
    const unresolvedEvidenceRefs = compactStringList([
      ...(Array.isArray(stage.unresolvedEvidenceRefs) ? stage.unresolvedEvidenceRefs : []),
      ...(Array.isArray(stage.unresolved_evidence_refs) ? stage.unresolved_evidence_refs : []),
    ]);
    const evidenceRefs = compactStringList([
      ...evidenceRefsFromValue(stage),
      stage.proofId,
      stage.proof_id,
    ]);
    const contractEvidencePresent = firstBool(
      stage.contractEvidencePresent,
      stage.contract_evidence_present,
    ) === true;
    const runtimeObserved = firstBool(
      stage.runtimeObserved,
      stage.runtime_observed,
    ) === true;
    return [stageName, {
      present,
      contractEvidencePresent,
      contract_evidence_present: contractEvidencePresent,
      runtimeObserved,
      runtime_observed: runtimeObserved,
      evidenceRefs,
      evidence_refs: evidenceRefs,
      unresolvedEvidenceRefs,
      unresolved_evidence_refs: unresolvedEvidenceRefs,
      failedGaps: compactStringList([
        !present ? `real_rocm_app_hook_contract_stage_${stageName}_missing` : null,
        present && !contractEvidencePresent
          ? `real_rocm_app_hook_contract_stage_${stageName}_evidence_missing`
          : null,
        present && !runtimeObserved
          ? `real_rocm_app_hook_contract_stage_${stageName}_runtime_missing`
          : null,
        present && evidenceRefs.length === 0
          ? `real_rocm_app_hook_contract_stage_${stageName}_evidence_refs_missing`
          : null,
        unresolvedEvidenceRefs.length > 0
          ? `real_rocm_app_hook_contract_stage_${stageName}_unresolved_evidence_refs`
          : null,
      ]),
    }];
  }));
  const stageFailedGaps = Object.values(stageChecks).flatMap((stage) => stage.failedGaps);
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
  const semanticFailedGaps = compactStringList([
    facetPresent && schemaVersion !== 'synthi.gpu_hmr.real_rocm_app_hook_contract_facet.v1'
      ? 'real_rocm_app_hook_contract_schema_missing'
      : null,
    facetPresent && !contentAddressedSha256(contractHash)
      ? 'real_rocm_app_hook_contract_hash_missing'
      : null,
    facetPresent && Object.keys(stageResults).length === 0
      ? 'real_rocm_app_hook_contract_stage_results_missing'
      : null,
    facetPresent && firstBool(
      contract.canSatisfyRuntimeProof,
      contract.can_satisfy_runtime_proof,
    ) !== true
      ? 'real_rocm_app_hook_contract_runtime_proof_flag_false'
      : null,
    facetPresent && firstBool(
      contract.contractEvidenceComplete,
      contract.contract_evidence_complete,
    ) !== true
      ? 'real_rocm_app_hook_contract_evidence_incomplete'
      : null,
    facetPresent && firstBool(
      contract.runtimeObservationComplete,
      contract.runtime_observation_complete,
    ) !== true
      ? 'real_rocm_app_hook_contract_runtime_observation_incomplete'
      : null,
    facetPresent && directBlockingGaps.length > 0
      ? 'real_rocm_app_hook_contract_blocking_gaps_present'
      : null,
    ...stageFailedGaps,
  ]);
  const proven =
    facetPresent
    && (
      contract.canSatisfyRuntimeProof === true
      || contract.can_satisfy_runtime_proof === true
    )
    && semanticFailedGaps.length === 0;
  return {
    required,
    facetPresent,
    proven,
    accepted: !required || proven,
    missing: required && !facetPresent,
    schemaVersion,
    schema_version: schemaVersion,
    stageChecks,
    stage_checks: stageChecks,
    semanticFailedGaps,
    semantic_failed_gaps: semanticFailedGaps,
    failedGaps: compactStringList([
      required && !facetPresent ? 'real_rocm_app_hook_contract_missing' : null,
      required && !proven ? 'real_rocm_app_hook_contract_required' : null,
      ...(required ? semanticFailedGaps : []),
    ]),
  };
}

function realRocmSameProcessRuntimeOracleGate({
  required = false,
  realRocmSameProcessRuntimeOracle = {},
  realRocmAppHookContractGate: appHookGate = {},
  runtimeProofArtifactGate = {},
  ledger = {},
  proofLedger = {},
  realRocmRuntimeChain = {},
  outputOracleFacet = {},
  realRocmFirewall = {},
} = {}) {
  const facet = compactObject(realRocmSameProcessRuntimeOracle);
  const present = Object.keys(facet).length > 0;
  const schemaVersion = firstText(facet.schemaVersion, facet.schema_version, facet.schema);
  const stageResults = compactObject(facet.stageResults ?? facet.stage_results);
  const dispatchStage = compactObject(stageResults.dispatch_trace ?? stageResults.dispatchTrace);
  const outputStage = compactObject(stageResults.output_oracle ?? stageResults.outputOracle);
  const facetEvidenceRefs = compactStringList(evidenceRefsFromValue(facet));
  const runtimeProofId = firstText(runtimeProofArtifactGate.proofId, runtimeProofArtifactGate.proof_id);
  const ledgerRecord = compactObject(ledger.record ?? proofLedger.records?.[0] ?? proofLedger.record);
  const closureEvidenceRefs = compactStringList([
    runtimeProofId,
    firstText(ledgerRecord.proofId, ledgerRecord.proof_id),
    firstText(realRocmRuntimeChain.artifactHash, realRocmRuntimeChain.artifact_hash),
    firstText(realRocmRuntimeChain.epoch),
    firstText(realRocmRuntimeChain.dispatchId, realRocmRuntimeChain.dispatch_id),
    firstText(realRocmRuntimeChain.outputTargetId, realRocmRuntimeChain.output_target_id),
  ]);
  const proofClosureChecks = {
    ledgerAccepted: ledger.present === true
      && ledger.source === 'recomputed_ledger'
      && ledger.gpuHmrSuccess === true
      && Array.isArray(ledger.failedInvariants)
      && ledger.failedInvariants.length === 0,
    runtimeChainAccepted: realRocmRuntimeChain.accepted === true,
    outputOracleFacetAccepted: outputOracleFacet.accepted === true,
    firewallEvidenceAccepted: realRocmFirewall.accepted === true,
    runtimeArtifactProofIdPresent: Boolean(runtimeProofId),
    stageResultsPresent: Object.keys(stageResults).length > 0,
    dispatchStageEpochMatched: firstBool(
      dispatchStage.dispatchUsedPublishedEpoch,
      dispatchStage.dispatch_used_published_epoch,
      facet.dispatchUsedPublishedEpoch,
      facet.dispatch_used_published_epoch,
    ) === true,
    outputStageTargetMatched: firstBool(
      outputStage.outputTargetMatched,
      outputStage.output_target_matched,
      facet.outputTargetMatched,
      facet.output_target_matched,
    ) === true,
    outputStageAfterDispatch: firstBool(
      outputStage.outputAfterDispatchObserved,
      outputStage.output_after_dispatch_observed,
      facet.outputAfterDispatchObserved,
      facet.output_after_dispatch_observed,
    ) === true,
    runtimeChainHasArtifact: Boolean(firstText(realRocmRuntimeChain.artifactHash, realRocmRuntimeChain.artifact_hash)),
    runtimeChainHasEpoch: Boolean(firstText(realRocmRuntimeChain.epoch)),
    runtimeChainHasDispatch: Boolean(firstText(realRocmRuntimeChain.dispatchId, realRocmRuntimeChain.dispatch_id)),
    runtimeChainHasOutputTarget: Boolean(firstText(realRocmRuntimeChain.outputTargetId, realRocmRuntimeChain.output_target_id)),
    evidenceRefsClosed: closureEvidenceRefs.length > 0
      && closureEvidenceRefs.some((ref) => facetEvidenceRefs.includes(ref)),
  };
  const blockingGaps = compactStringList([
    ...(Array.isArray(facet.blockingGaps) ? facet.blockingGaps : []),
    ...(Array.isArray(facet.blocking_gaps) ? facet.blocking_gaps : []),
  ]);
  const requiredByFacet =
    facet.required === true
    || facet.declared === true
    || facet.appHookRequired === true
    || facet.app_hook_required === true;
  const actuallyRequired = required || appHookGate.required === true || requiredByFacet;
  const acceptedFlag = firstBool(
    facet.accepted,
    facet.canSatisfyRuntimeProof,
    facet.can_satisfy_runtime_proof,
  );
  const checks = {
    schemaAccepted: schemaVersion === 'synthi.gpu_hmr.same_process_runtime_oracle_contract.v1',
    appHookContractAccepted: firstBool(
      facet.appHookContractAccepted,
      facet.app_hook_contract_accepted,
    ) === true,
    nativeRuntimeBridgeAccepted: firstBool(
      facet.nativeRuntimeBridgeAccepted,
      facet.native_runtime_bridge_accepted,
    ) === true,
    runtimeProofBridgeAccepted: firstBool(
      facet.runtimeProofBridgeAccepted,
      facet.runtime_proof_bridge_accepted,
      facet.appHookContractAccepted,
      facet.app_hook_contract_accepted,
      facet.nativeRuntimeBridgeAccepted,
      facet.native_runtime_bridge_accepted,
    ) === true,
    artifactTransportObserved: firstBool(
      facet.artifactTransportObserved,
      facet.artifact_transport_observed,
    ) === true,
    epochPublicationObserved: firstBool(
      facet.epochPublicationObserved,
      facet.epoch_publication_observed,
    ) === true,
    dispatchTraceObserved: firstBool(
      facet.dispatchTraceObserved,
      facet.dispatch_trace_observed,
    ) === true,
    dispatchUsedPublishedEpoch: firstBool(
      facet.dispatchUsedPublishedEpoch,
      facet.dispatch_used_published_epoch,
    ) === true,
    sameProcessIdentityObserved: firstBool(
      facet.sameProcessIdentityObserved,
      facet.same_process_identity_observed,
      facet.processIdentityObserved,
      facet.process_identity_observed,
    ) === true,
    outputOracleObserved: firstBool(
      facet.outputOracleObserved,
      facet.output_oracle_observed,
    ) === true,
    outputTargetObserved: firstBool(
      facet.outputTargetObserved,
      facet.output_target_observed,
    ) === true,
    outputTargetMatched: firstBool(
      facet.outputTargetMatched,
      facet.output_target_matched,
    ) === true,
    outputAfterDispatchObserved: firstBool(
      facet.outputAfterDispatchObserved,
      facet.output_after_dispatch_observed,
    ) === true,
    artifactEpochMatched: firstBool(
      facet.artifactEpochMatched,
      facet.artifact_epoch_matched,
    ) === true,
    firewallAccepted: firstBool(facet.firewallAccepted, facet.firewall_accepted) === true,
    cpuHmrFalse: firstBool(facet.cpuHmrUsed, facet.cpu_hmr_used) === false,
    fullRebuildFalse: firstBool(facet.fullRebuildUsed, facet.full_rebuild_used) === false,
    processRestartFalse: firstBool(facet.processRestarted, facet.process_restarted) === false,
    runtimeProofArtifactAccepted: runtimeProofArtifactGate.accepted === true,
  };
  const failedGates = compactStringList([
    actuallyRequired && !present ? 'same_process_runtime_oracle_contract_missing' : null,
    present && !checks.schemaAccepted ? 'same_process_runtime_oracle_contract_schema_missing' : null,
    present && acceptedFlag !== true ? 'same_process_runtime_oracle_contract_not_accepted' : null,
    present && appHookGate.required === true && !checks.appHookContractAccepted
      ? 'same_process_runtime_oracle_app_hook_contract_unproven'
      : null,
    present && !checks.runtimeProofBridgeAccepted
      ? 'same_process_runtime_oracle_runtime_proof_bridge_unproven'
      : null,
    present && !checks.artifactTransportObserved ? 'same_process_runtime_oracle_artifact_transport_missing' : null,
    present && !checks.epochPublicationObserved ? 'same_process_runtime_oracle_epoch_publication_missing' : null,
    present && !checks.dispatchTraceObserved ? 'same_process_runtime_oracle_dispatch_trace_missing' : null,
    present && !checks.dispatchUsedPublishedEpoch ? 'same_process_runtime_oracle_dispatch_epoch_mismatch' : null,
    present && !checks.sameProcessIdentityObserved ? 'same_process_runtime_oracle_process_identity_missing' : null,
    present && !checks.outputOracleObserved ? 'same_process_runtime_oracle_output_oracle_missing' : null,
    present && !checks.outputTargetObserved ? 'same_process_runtime_oracle_output_target_missing' : null,
    present && checks.outputTargetObserved && !checks.outputTargetMatched
      ? 'same_process_runtime_oracle_output_target_mismatch'
      : null,
    present && !checks.outputAfterDispatchObserved ? 'same_process_runtime_oracle_after_dispatch_missing' : null,
    present && !checks.artifactEpochMatched ? 'same_process_runtime_oracle_artifact_epoch_mismatch' : null,
    present && !checks.firewallAccepted ? 'same_process_runtime_oracle_firewall_missing' : null,
    present && !checks.cpuHmrFalse ? 'same_process_runtime_oracle_cpu_hmr_false_missing' : null,
    present && !checks.fullRebuildFalse ? 'same_process_runtime_oracle_full_rebuild_false_missing' : null,
    present && !checks.processRestartFalse ? 'same_process_runtime_oracle_process_restart_false_missing' : null,
    present && !checks.runtimeProofArtifactAccepted
      ? 'same_process_runtime_oracle_strict_runtime_proof_artifact_missing'
      : null,
    present && !proofClosureChecks.ledgerAccepted
      ? 'same_process_runtime_oracle_ledger_closure_missing'
      : null,
    present && !proofClosureChecks.runtimeChainAccepted
      ? 'same_process_runtime_oracle_runtime_chain_closure_missing'
      : null,
    present && !proofClosureChecks.outputOracleFacetAccepted
      ? 'same_process_runtime_oracle_output_oracle_closure_missing'
      : null,
    present && !proofClosureChecks.firewallEvidenceAccepted
      ? 'same_process_runtime_oracle_firewall_closure_missing'
      : null,
    present && !proofClosureChecks.runtimeArtifactProofIdPresent
      ? 'same_process_runtime_oracle_runtime_proof_id_missing'
      : null,
    present && !proofClosureChecks.stageResultsPresent
      ? 'same_process_runtime_oracle_stage_results_missing'
      : null,
    present && !proofClosureChecks.dispatchStageEpochMatched
      ? 'same_process_runtime_oracle_stage_dispatch_epoch_mismatch'
      : null,
    present && !proofClosureChecks.outputStageTargetMatched
      ? 'same_process_runtime_oracle_stage_output_target_mismatch'
      : null,
    present && !proofClosureChecks.outputStageAfterDispatch
      ? 'same_process_runtime_oracle_stage_after_dispatch_missing'
      : null,
    present && !proofClosureChecks.runtimeChainHasArtifact
      ? 'same_process_runtime_oracle_runtime_chain_artifact_missing'
      : null,
    present && !proofClosureChecks.runtimeChainHasEpoch
      ? 'same_process_runtime_oracle_runtime_chain_epoch_missing'
      : null,
    present && !proofClosureChecks.runtimeChainHasDispatch
      ? 'same_process_runtime_oracle_runtime_chain_dispatch_missing'
      : null,
    present && !proofClosureChecks.runtimeChainHasOutputTarget
      ? 'same_process_runtime_oracle_runtime_chain_output_target_missing'
      : null,
    present && !proofClosureChecks.evidenceRefsClosed
      ? 'same_process_runtime_oracle_evidence_ref_closure_missing'
      : null,
    ...blockingGaps,
  ]);
  const accepted =
    !actuallyRequired
    || (
      present
      && failedGates.length === 0
    );
  return {
    required: actuallyRequired,
    present,
    accepted,
    proven: accepted && actuallyRequired,
    status: present ? firstText(facet.status, facet.reason) : null,
    checks,
    proofClosureChecks,
    proof_closure_checks: proofClosureChecks,
    closureEvidenceRefs,
    closure_evidence_refs: closureEvidenceRefs,
    failedGates,
    failed_gates: failedGates,
  };
}

function realRocmSidecarRuntimeConsistencyGate(input = {}) {
  const facet = compactObject(input);
  const present = Object.keys(facet).length > 0;
  if (!present) {
    return {
      present: false,
      accepted: false,
      status: null,
      failedGates: ['real_rocm_sidecar_runtime_consistency_missing'],
      failed_gates: ['real_rocm_sidecar_runtime_consistency_missing'],
    };
  }
  const schemaVersion = firstText(facet.schemaVersion, facet.schema_version, facet.schema);
  const status = firstText(facet.status, facet.reason);
  const blockingGaps = compactStringList([
    ...(Array.isArray(facet.blockingGaps) ? facet.blockingGaps : []),
    ...(Array.isArray(facet.blocking_gaps) ? facet.blocking_gaps : []),
  ]);
  const acceptedFlag = firstBool(facet.accepted, facet.runtimeConsistencyAccepted);
  const backendConsistent = firstBool(facet.backendConsistent, facet.backend_consistent);
  const canSatisfyRuntimeProof = firstBool(
    facet.canSatisfyRuntimeProof,
    facet.can_satisfy_runtime_proof,
  );
  const notApplicable =
    firstBool(facet.notApplicable, facet.not_applicable) === true
    || status === 'not_applicable'
    || status === 'no_device_sidecar_applicable';
  const failedGates = compactStringList([
    schemaVersion ? null : 'real_rocm_sidecar_runtime_consistency_schema_missing',
    schemaVersion && schemaVersion !== REAL_ROCM_SIDECAR_RUNTIME_CONSISTENCY_SCHEMA_VERSION
      ? 'real_rocm_sidecar_runtime_consistency_schema_unknown'
      : null,
    ...blockingGaps,
    !notApplicable && backendConsistent !== true ? 'sidecar_runtime_backend_consistency_not_proven' : null,
    !notApplicable && acceptedFlag !== true && canSatisfyRuntimeProof !== true
      ? 'sidecar_runtime_not_explicitly_accepted'
      : null,
  ]);
  return {
    present: true,
    accepted: failedGates.length === 0,
    notApplicable,
    not_applicable: notApplicable,
    schemaVersion,
    schema_version: schemaVersion,
    status: status ?? null,
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates,
    failed_gates: failedGates,
  };
}

function realRocmRuntimeStageObligationsGate(input = {}) {
  const facet = compactObject(input);
  const present = Object.keys(facet).length > 0;
  if (!present) {
    return {
      present: false,
      accepted: null,
      status: null,
      required: false,
      failedGates: [],
      failed_gates: [],
    };
  }
  const schemaVersion = firstText(facet.schemaVersion, facet.schema_version, facet.schema);
  const status = firstText(facet.status, facet.reason);
  const required = firstBool(facet.required) === true;
  const acceptedFlag = firstBool(
    facet.accepted,
    facet.readyForAcceptance,
    facet.ready_for_acceptance,
  );
  const canSatisfyRuntimeProof = firstBool(
    facet.canSatisfyRuntimeProof,
    facet.can_satisfy_runtime_proof,
  );
  const proofAuthority = firstText(facet.proofAuthority, facet.proof_authority);
  const stageResults = compactObject(facet.stageResults ?? facet.stage_results);
  const blockingGaps = compactStringList([
    ...(Array.isArray(facet.blockingGaps) ? facet.blockingGaps : []),
    ...(Array.isArray(facet.blocking_gaps) ? facet.blocking_gaps : []),
  ]);
  const missingStages = compactStringList([
    ...(Array.isArray(facet.missingStages) ? facet.missingStages : []),
    ...(Array.isArray(facet.missing_stages) ? facet.missing_stages : []),
  ]);
  const stageFailedGates = REAL_ROCM_APP_HOOK_REQUIRED_STAGES.flatMap((stageName) => {
    const camelStage = stageName.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    const stage = compactObject(stageResults[stageName] ?? stageResults[camelStage]);
    const stagePresent = Object.keys(stage).length > 0;
    const observed = firstBool(stage.observed, stage.runtimeObserved, stage.runtime_observed);
    const requiredProofKinds = compactStringList([
      ...(Array.isArray(stage.requiredProofKinds) ? stage.requiredProofKinds : []),
      ...(Array.isArray(stage.required_proof_kinds) ? stage.required_proof_kinds : []),
    ]);
    const missingProofKinds = compactStringList([
      ...(Array.isArray(stage.missingProofKinds) ? stage.missingProofKinds : []),
      ...(Array.isArray(stage.missing_proof_kinds) ? stage.missing_proof_kinds : []),
    ]);
    return compactStringList([
      !stagePresent ? `runtime_stage_obligation_${stageName}_missing` : null,
      stagePresent && requiredProofKinds.length === 0
        ? `runtime_stage_obligation_${stageName}_proof_kinds_missing`
        : null,
      stagePresent && observed !== true
        ? `runtime_stage_obligation_${stageName}_not_observed`
        : null,
      ...missingProofKinds.map((kind) =>
        `runtime_stage_obligation_${stageName}_${kind}_missing`
      ),
    ]);
  });
  const failedGates = compactStringList([
    schemaVersion ? null : 'runtime_stage_obligations_schema_missing',
    schemaVersion && schemaVersion !== REAL_ROCM_RUNTIME_STAGE_OBLIGATIONS_SCHEMA_VERSION
      ? 'runtime_stage_obligations_schema_unknown'
      : null,
    required && acceptedFlag !== true ? 'runtime_stage_obligations_not_accepted' : null,
    canSatisfyRuntimeProof === true ? 'runtime_stage_obligations_claimed_runtime_authority' : null,
    proofAuthority === 'derived_runtime_stage_obligation_ledger_not_runtime_proof'
      ? null
      : 'runtime_stage_obligations_authority_unknown',
    required && Object.keys(stageResults).length === 0 ? 'runtime_stage_obligations_stage_results_missing' : null,
    ...stageFailedGates,
    ...blockingGaps,
  ]);
  return {
    present: true,
    required,
    accepted: !required || failedGates.length === 0,
    status: status ?? null,
    schemaVersion,
    schema_version: schemaVersion,
    proofAuthority,
    proof_authority: proofAuthority,
    missingStages,
    missing_stages: missingStages,
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates,
    failed_gates: failedGates,
  };
}

function realRocmAppHookMaterializationGate(input = {}) {
  const facet = compactObject(input);
  const present = Object.keys(facet).length > 0;
  if (!present) {
    return {
      present: false,
      accepted: null,
      status: null,
      required: false,
      failedGates: [],
      failed_gates: [],
      blockingGaps: [],
      blocking_gaps: [],
    };
  }
  const schemaVersion = firstText(facet.schemaVersion, facet.schema_version, facet.schema);
  const proofAuthority = firstText(facet.proofAuthority, facet.proof_authority);
  const status = firstText(facet.status, facet.reason);
  const required = firstBool(facet.required) === true;
  const acceptedForGpuHmr = firstBool(
    facet.acceptedForGpuHmr,
    facet.accepted_for_gpu_hmr,
  );
  const gpuHmrSuccess = firstBool(facet.gpuHmrSuccess, facet.gpu_hmr_success);
  const canSatisfyRuntimeProof = firstBool(
    facet.canSatisfyRuntimeProof,
    facet.can_satisfy_runtime_proof,
  );
  const canSatisfyDispatchProof = firstBool(
    facet.canSatisfyDispatchProof,
    facet.can_satisfy_dispatch_proof,
  );
  const acceptedAsRefusalEvidence = firstBool(
    facet.acceptedAsRefusalEvidence,
    facet.accepted_as_refusal_evidence,
  );
  const appHookAuthoringReady = firstBool(
    facet.appHookAuthoringReady,
    facet.app_hook_authoring_ready,
  );
  const materializationComplete = firstBool(
    facet.materializationComplete,
    facet.materialization_complete,
  );
  const stagePlans = compactObject(facet.stagePlans ?? facet.stage_plans);
  const blockingGaps = compactStringList([
    ...(Array.isArray(facet.blockingGaps) ? facet.blockingGaps : []),
    ...(Array.isArray(facet.blocking_gaps) ? facet.blocking_gaps : []),
  ]);
  const stagePlanFailures = required
    ? REAL_ROCM_APP_HOOK_REQUIRED_STAGES.flatMap((stageName) => {
      const camelStage = stageName.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
      const stage = compactObject(stagePlans[stageName] ?? stagePlans[camelStage]);
      const proofKinds = compactStringList([
        ...(Array.isArray(stage.proofKinds) ? stage.proofKinds : []),
        ...(Array.isArray(stage.proof_kinds) ? stage.proof_kinds : []),
      ]);
      return compactStringList([
        Object.keys(stage).length === 0
          ? `app_hook_materialization_${stageName}_plan_missing`
          : null,
        Object.keys(stage).length > 0 && proofKinds.length === 0
          ? `app_hook_materialization_${stageName}_proof_kinds_missing`
          : null,
      ]);
    })
    : [];
  const failedGates = compactStringList([
    schemaVersion ? null : 'real_rocm_app_hook_materialization_schema_missing',
    schemaVersion && schemaVersion !== REAL_ROCM_APP_HOOK_MATERIALIZATION_SCHEMA_VERSION
      ? 'real_rocm_app_hook_materialization_schema_unknown'
      : null,
    proofAuthority === 'plan_only_app_hook_materialization_not_runtime_proof'
      ? null
      : 'real_rocm_app_hook_materialization_authority_unknown',
    acceptedForGpuHmr === true
      ? 'real_rocm_app_hook_materialization_claimed_gpu_hmr_acceptance'
      : null,
    gpuHmrSuccess === true
      ? 'real_rocm_app_hook_materialization_claimed_gpu_hmr_success'
      : null,
    canSatisfyRuntimeProof === true
      ? 'real_rocm_app_hook_materialization_claimed_runtime_authority'
      : null,
    canSatisfyDispatchProof === true
      ? 'real_rocm_app_hook_materialization_claimed_dispatch_authority'
      : null,
    acceptedAsRefusalEvidence === true && blockingGaps.length === 0
      ? 'real_rocm_app_hook_materialization_refusal_gaps_missing'
      : null,
    materializationComplete === true && blockingGaps.length > 0
      ? 'real_rocm_app_hook_materialization_complete_with_blocking_gaps'
      : null,
    appHookAuthoringReady === true && blockingGaps.some((gap) =>
      text(gap)?.includes('candidate_missing')
      || text(gap)?.includes('sidecar')
      || text(gap)?.includes('compile_bridge_candidate_missing')
      || text(gap)?.includes('output_oracle_contract_missing')
    )
      ? 'real_rocm_app_hook_materialization_authoring_ready_with_candidate_gaps'
      : null,
    required && Object.keys(stagePlans).length === 0
      ? 'real_rocm_app_hook_materialization_stage_plans_missing'
      : null,
    ...stagePlanFailures,
  ]);
  return {
    present: true,
    required,
    accepted: failedGates.length === 0,
    status: status ?? null,
    schemaVersion,
    schema_version: schemaVersion,
    proofAuthority,
    proof_authority: proofAuthority,
    appHookAuthoringReady,
    app_hook_authoring_ready: appHookAuthoringReady,
    materializationComplete,
    materialization_complete: materializationComplete,
    acceptedAsRefusalEvidence: acceptedAsRefusalEvidence === true,
    accepted_as_refusal_evidence: acceptedAsRefusalEvidence === true,
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates,
    failed_gates: failedGates,
  };
}

function validationBlockerGate(input = {}) {
  const blocker = compactObject(input);
  const present = Object.keys(blocker).length > 0;
  if (!present) {
    return {
      present: false,
      accepted: null,
      acceptedAsRefusalEvidence: false,
      accepted_as_refusal_evidence: false,
      failedGates: [],
      failed_gates: [],
      blockingGaps: [],
      blocking_gaps: [],
    };
  }
  const schemaVersion = firstText(blocker.schemaVersion, blocker.schema_version, blocker.schema);
  const proofAuthority = firstText(blocker.proofAuthority, blocker.proof_authority);
  const acceptedAsRefusalEvidence = firstBool(
    blocker.acceptedAsRefusalEvidence,
    blocker.accepted_as_refusal_evidence,
  ) === true;
  const acceptedForGpuHmr = firstBool(
    blocker.acceptedForGpuHmr,
    blocker.accepted_for_gpu_hmr,
  );
  const gpuHmrSuccess = firstBool(blocker.gpuHmrSuccess, blocker.gpu_hmr_success);
  const canSatisfyRuntimeProof = firstBool(
    blocker.canSatisfyRuntimeProof,
    blocker.can_satisfy_runtime_proof,
  );
  const blockingGaps = compactStringList([
    ...(Array.isArray(blocker.blockingGaps) ? blocker.blockingGaps : []),
    ...(Array.isArray(blocker.blocking_gaps) ? blocker.blocking_gaps : []),
  ]);
  const failedGates = compactStringList([
    schemaVersion ? null : 'validation_blocker_schema_missing',
    schemaVersion && schemaVersion !== VALIDATION_BLOCKER_SCHEMA_VERSION
      ? 'validation_blocker_schema_unknown'
      : null,
    proofAuthority === 'validation_blocker_only_not_gpu_hmr_success'
      ? null
      : 'validation_blocker_authority_unknown',
    acceptedForGpuHmr === true ? 'validation_blocker_claimed_gpu_hmr_acceptance' : null,
    gpuHmrSuccess === true ? 'validation_blocker_claimed_gpu_hmr_success' : null,
    canSatisfyRuntimeProof === true ? 'validation_blocker_claimed_runtime_authority' : null,
    acceptedAsRefusalEvidence && blockingGaps.length === 0
      ? 'validation_blocker_blocking_gaps_missing'
      : null,
  ]);
  return {
    present: true,
    accepted: acceptedAsRefusalEvidence && failedGates.length === 0,
    acceptedAsRefusalEvidence,
    accepted_as_refusal_evidence: acceptedAsRefusalEvidence,
    status: firstText(blocker.status, blocker.reason),
    schemaVersion,
    schema_version: schemaVersion,
    proofAuthority,
    proof_authority: proofAuthority,
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates,
    failed_gates: failedGates,
  };
}

function realRocmProofSchedulingGate(input = {}) {
  const facet = compactObject(input);
  const present = Object.keys(facet).length > 0;
  if (!present) {
    return {
      present: false,
      accepted: null,
      acceptedAsRefusalEvidence: false,
      accepted_as_refusal_evidence: false,
      fastFailApplied: false,
      fast_fail_applied: false,
      skipAsyncRuntimeWaits: false,
      skip_async_runtime_waits: false,
      failedGates: [],
      failed_gates: [],
      blockingGaps: [],
      blocking_gaps: [],
      validationBlockers: [],
      validation_blockers: [],
    };
  }
  const schemaVersion = firstText(facet.schemaVersion, facet.schema_version, facet.schema);
  const proofAuthority = firstText(facet.proofAuthority, facet.proof_authority);
  const acceptedAsRefusalEvidence = firstBool(
    facet.acceptedAsRefusalEvidence,
    facet.accepted_as_refusal_evidence,
  ) === true;
  const fastFailApplied = firstBool(facet.fastFailApplied, facet.fast_fail_applied) === true;
  const events = compactObjectList(facet.events);
  const skipAsyncRuntimeWaits = (
    firstBool(facet.skipAsyncRuntimeWaits, facet.skip_async_runtime_waits) === true
    || events.some((event) =>
      firstBool(event.skipAsyncRuntimeWaits, event.skip_async_runtime_waits) === true
    )
  );
  const acceptedForGpuHmr = firstBool(
    facet.acceptedForGpuHmr,
    facet.accepted_for_gpu_hmr,
  );
  const gpuHmrSuccess = firstBool(facet.gpuHmrSuccess, facet.gpu_hmr_success);
  const canSatisfyRuntimeProof = firstBool(
    facet.canSatisfyRuntimeProof,
    facet.can_satisfy_runtime_proof,
  );
  const validationBlockers = compactObjectList([
    ...(Array.isArray(facet.validationBlockers) ? facet.validationBlockers : []),
    ...(Array.isArray(facet.validation_blockers) ? facet.validation_blockers : []),
    facet.validationBlocker,
    facet.validation_blocker,
  ]);
  const blockerGates = validationBlockers.map(validationBlockerGate);
  const acceptedBlockerCount = blockerGates.filter((gate) => gate.accepted === true).length;
  const blockingGaps = compactStringList([
    ...(Array.isArray(facet.blockingGaps) ? facet.blockingGaps : []),
    ...(Array.isArray(facet.blocking_gaps) ? facet.blocking_gaps : []),
    ...events.flatMap((event) => [
      ...(Array.isArray(event.blockingGaps) ? event.blockingGaps : []),
      ...(Array.isArray(event.blocking_gaps) ? event.blocking_gaps : []),
    ]),
    ...blockerGates.flatMap((gate) => gate.blockingGaps),
  ]);
  const failedGates = compactStringList([
    schemaVersion ? null : 'real_rocm_proof_scheduling_schema_missing',
    schemaVersion && schemaVersion !== REAL_ROCM_PROOF_SCHEDULING_SCHEMA_VERSION
      ? 'real_rocm_proof_scheduling_schema_unknown'
      : null,
    proofAuthority === 'proof_scheduling_evidence_only_not_gpu_hmr_success'
      ? null
      : 'real_rocm_proof_scheduling_authority_unknown',
    acceptedForGpuHmr === true ? 'real_rocm_proof_scheduling_claimed_gpu_hmr_acceptance' : null,
    gpuHmrSuccess === true ? 'real_rocm_proof_scheduling_claimed_gpu_hmr_success' : null,
    canSatisfyRuntimeProof === true ? 'real_rocm_proof_scheduling_claimed_runtime_authority' : null,
    acceptedAsRefusalEvidence && acceptedBlockerCount === 0
      ? 'real_rocm_proof_scheduling_refusal_blocker_missing'
      : null,
    acceptedAsRefusalEvidence && blockingGaps.length === 0
      ? 'real_rocm_proof_scheduling_blocking_gaps_missing'
      : null,
    skipAsyncRuntimeWaits && !fastFailApplied
      ? 'real_rocm_proof_scheduling_skip_without_fast_fail'
      : null,
    skipAsyncRuntimeWaits && !blockingGaps.includes('proof_scheduling_upstream_lifecycle_runtime_absent')
      ? 'real_rocm_proof_scheduling_skip_without_upstream_runtime_absence'
      : null,
    ...blockerGates.flatMap((gate) =>
      gate.failedGates.map((failure) => `validation_blocker:${failure}`)
    ),
  ]);
  return {
    present: true,
    accepted: acceptedAsRefusalEvidence && failedGates.length === 0,
    acceptedAsRefusalEvidence,
    accepted_as_refusal_evidence: acceptedAsRefusalEvidence,
    fastFailApplied,
    fast_fail_applied: fastFailApplied,
    skipAsyncRuntimeWaits,
    skip_async_runtime_waits: skipAsyncRuntimeWaits,
    status: firstText(facet.status, facet.reason),
    schemaVersion,
    schema_version: schemaVersion,
    proofAuthority,
    proof_authority: proofAuthority,
    blockingGaps,
    blocking_gaps: blockingGaps,
    failedGates,
    failed_gates: failedGates,
    validationBlockers,
    validation_blockers: validationBlockers,
    validationBlockerGates: blockerGates,
    validation_blocker_gates: blockerGates,
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
  const schemaVersion = firstText(raw.schemaVersion, raw.schema_version, raw.schema);
  const schemaAccepted = [
    REAL_ROCM_RUNTIME_CAPABILITY_PREFLIGHT_INPUT_SCHEMA_VERSION,
    REAL_ROCM_RUNTIME_CAPABILITY_PREFLIGHT_FACET_SCHEMA_VERSION,
  ].includes(schemaVersion);
  const observed = firstBool(
    raw.observed,
    raw.runtimeCapabilityPreflightObserved,
    raw.runtime_capability_preflight_observed,
  );
  const backend = firstText(raw.backend);
  const api = firstText(raw.api);
  const probe = firstText(raw.probe);
  const evidenceRefs = compactStringList(evidenceRefsFromValue(raw));
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
    schemaVersion ? null : 'runtime_capability_preflight_schema_missing',
    schemaVersion && !schemaAccepted ? 'runtime_capability_preflight_schema_unknown' : null,
    observed === true ? null : 'runtime_capability_preflight_not_observed',
    backend ? null : 'runtime_capability_preflight_backend_missing',
    backend && !['rocm', 'hip'].includes(backend) ? 'runtime_capability_preflight_backend_not_rocm' : null,
    api ? null : 'runtime_capability_preflight_api_missing',
    probe ? null : 'runtime_capability_preflight_probe_missing',
    evidenceRefs.length > 0 ? null : 'runtime_capability_preflight_evidence_refs_missing',
    degradedState,
    noDeviceEvidence ? 'runtime_device_unavailable' : null,
    deviceCount === null ? 'runtime_device_count_missing' : null,
    deviceCount === 0 ? 'runtime_device_count_zero' : null,
    deviceCount !== null && deviceCount < 0 ? 'runtime_device_count_invalid' : null,
    deviceCountResult === null ? 'runtime_device_count_probe_missing' : null,
    deviceCountResult !== null && deviceCountResult !== 0 ? 'runtime_device_count_probe_failed' : null,
    allocationResult === null ? 'runtime_array_allocation_probe_missing' : null,
    allocationResult !== null && allocationResult !== 0 ? 'runtime_array_allocation_probe_failed' : null,
    allocationAvailable === true ? null : 'runtime_array_allocation_success_missing',
    anyAllocationAvailable === true ? null : 'runtime_any_array_allocation_success_missing',
    allocationAvailable === false ? 'runtime_array_allocation_unavailable' : null,
    anyAllocationAvailable === false ? 'runtime_any_array_allocation_unavailable' : null,
    allocationMatrixTotal === null || allocationMatrixTotal <= 0 ? 'runtime_array_allocation_matrix_missing' : null,
    allAllocationMatrixFailed ? 'runtime_array_allocation_matrix_failed' : null,
    textureResourceFallbackAvailable === true ? null : 'runtime_texture_fallback_success_missing',
    textureResourceFallbackAvailable === false ? 'runtime_texture_fallback_unavailable' : null,
    textureResourceMatrixTotal === null || textureResourceMatrixTotal <= 0
      ? 'runtime_texture_resource_matrix_missing'
      : null,
    allTextureMatrixFailed ? 'runtime_texture_resource_matrix_failed' : null,
    exitCode === null ? 'runtime_capability_preflight_exit_code_missing' : null,
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
    schemaVersion: REAL_ROCM_RUNTIME_CAPABILITY_PREFLIGHT_FACET_SCHEMA_VERSION,
    present: true,
    accepted,
    status,
    proofAuthority: 'runtime_capability_preflight_evidence_only_not_gpu_hmr_success',
    proof_authority: 'runtime_capability_preflight_evidence_only_not_gpu_hmr_success',
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    inputSchemaVersion: schemaVersion ?? null,
    input_schema_version: schemaVersion ?? null,
    observed,
    backend,
    api,
    probe,
    evidenceRefs,
    evidence_refs: evidenceRefs,
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

function fullRuntimeLedgerAuthorityFailures(row) {
  const failures = [];
  const ledger = compactObject(row.ledger);
  const record = compactObject(ledger.record);
  const failedInvariants = Array.isArray(ledger.failedInvariants)
    ? ledger.failedInvariants
    : Array.isArray(ledger.failed_invariants)
      ? ledger.failed_invariants
      : null;
  const ledgerProofId = firstText(ledger.proofId, ledger.proof_id);
  const recordProofId = firstText(record.proofId, record.proof_id);
  const rowBackend = valueFieldText(row.backend);
  const recordBackend = valueFieldText(record.backend);
  const recomputed = Object.keys(record).length > 0
    ? queryGpuHmrLedgerInvariants({ records: [record] })
    : null;
  const proofIds = compactStringList(row.proofIds ?? row.proof_ids);
  if (ledger.present !== true) {
    failures.push({ code: 'gpu_hmr_success_requires_embedded_proof_ledger' });
  }
  if (ledger.source !== 'recomputed_ledger') {
    failures.push({ code: 'gpu_hmr_success_requires_recomputed_proof_ledger' });
  }
  if (ledger.gpuHmrSuccess !== true) {
    failures.push({ code: 'gpu_hmr_success_requires_ledger_success' });
  }
  if (failedInvariants === null) {
    failures.push({ code: 'gpu_hmr_success_requires_ledger_invariant_list' });
  } else if (failedInvariants.length > 0) {
    failures.push({ code: 'gpu_hmr_success_requires_zero_ledger_invariants' });
  }
  if (!ledgerProofId) {
    failures.push({ code: 'gpu_hmr_success_requires_ledger_proof_id' });
  }
  if (Object.keys(record).length === 0) {
    failures.push({ code: 'gpu_hmr_success_requires_proof_ledger_record' });
  }
  if (!recordProofId) {
    failures.push({ code: 'gpu_hmr_success_requires_ledger_record_proof_id' });
  }
  if (ledgerProofId && recordProofId && ledgerProofId !== recordProofId) {
    failures.push({ code: 'gpu_hmr_success_requires_ledger_record_proof_id_match' });
  }
  if (ledgerProofId && !proofIds.includes(ledgerProofId)) {
    failures.push({ code: 'gpu_hmr_success_requires_ledger_proof_id_in_row_proof_ids' });
  }
  if (rowBackend && recordBackend && rowBackend !== recordBackend) {
    failures.push({
      code: 'gpu_hmr_success_requires_row_backend_bound_to_ledger_record',
      rowBackend,
      recordBackend,
    });
  }
  if (recomputed !== null) {
    const recomputedRecord = compactObject(recomputed.record);
    const recomputedRecordProofId = firstText(recomputedRecord.proofId, recomputedRecord.proof_id);
    if (recomputed.gpuHmrSuccess !== true) {
      failures.push({ code: 'gpu_hmr_success_requires_recomputed_ledger_record_success' });
    }
    const recomputedFailures = Array.isArray(recomputed.failedInvariants) ? recomputed.failedInvariants : [];
    if (recomputedFailures.length > 0) {
      failures.push({
        code: 'gpu_hmr_success_requires_zero_recomputed_ledger_record_invariants',
        invariantCodes: compactStringList(recomputedFailures.map((failure) => compactObject(failure).code)),
      });
    }
    if (recordProofId && recomputedRecordProofId && recordProofId !== recomputedRecordProofId) {
      failures.push({ code: 'gpu_hmr_success_requires_recomputed_ledger_record_proof_id_match' });
    }
  }
  const missingFields = REQUIRED_FULL_RUNTIME_LEDGER_RECORD_FIELDS
    .filter((fieldNames) => !hasOwnAny(record, fieldNames))
    .map((fieldNames) => fieldNames[0]);
  if (missingFields.length > 0) {
    failures.push({
      code: 'gpu_hmr_success_requires_complete_ledger_record',
      missingFields,
    });
  }
  return failures;
}

function nativeRuntimeTraceEvidenceFacet(row = {}) {
  const runtimeTrace = compactObject(row.runtimeTrace ?? row.runtime_trace);
  const runtimeResourceTrace = compactObject(row.runtimeResourceTrace ?? row.runtime_resource_trace);
  const nativeHipApiEvidence = compactObject(row.nativeHipApiEvidence ?? row.native_hip_api_evidence);
  const ledgerRecord = ledgerRecordForRow(row);
  const traceDispatchEvent = compactObject(
    eventList(runtimeTrace.dispatchEvents, runtimeTrace.dispatch_events, runtimeTrace.dispatchEvent, runtimeTrace.dispatch_event)[0],
  );
  const traceLoaderEvent = compactObject(
    eventList(runtimeTrace.loaderEvents, runtimeTrace.loader_events, runtimeTrace.loaderEvent, runtimeTrace.loader_event)[0],
  );
  const traceOutputEvent = compactObject(
    eventList(runtimeTrace.outputEvents, runtimeTrace.output_events, runtimeTrace.outputEvent, runtimeTrace.output_event)[0],
  );
  const ledgerDispatchEvent = compactObject(ledgerRecord.dispatchEvent ?? ledgerRecord.dispatch_event);
  const ledgerLoaderEvent = compactObject(ledgerRecord.loaderEvent ?? ledgerRecord.loader_event);
  const ledgerOutputEvent = compactObject(ledgerRecord.outputEvent ?? ledgerRecord.output_event);
  const dispatchEvent = compactObject({ ...traceDispatchEvent, ...ledgerDispatchEvent });
  const loaderEvent = compactObject({ ...traceLoaderEvent, ...ledgerLoaderEvent });
  const outputEvent = compactObject({ ...traceOutputEvent, ...ledgerOutputEvent });
  const evidenceObjects = [
    runtimeTrace,
    runtimeResourceTrace,
    nativeHipApiEvidence,
    ledgerRecord,
    traceDispatchEvent,
    traceLoaderEvent,
    traceOutputEvent,
    dispatchEvent,
    loaderEvent,
    outputEvent,
  ].filter((value) => Object.keys(value).length > 0);
  const topLevelRuntimeTracePresent = Object.keys(runtimeTrace).length > 0
    || Object.keys(runtimeResourceTrace).length > 0
    || Object.keys(nativeHipApiEvidence).length > 0;
  const dispatchBoundaryPresent = firstText(
    dispatchEvent.command,
    dispatchEvent.launch_api,
    dispatchEvent.launchApi,
    dispatchEvent.pipeline_id,
    dispatchEvent.pipelineId,
  ) !== null;
  const loaderBoundaryPresent = firstText(
    loaderEvent.source,
    loaderEvent.command,
    loaderEvent.loader_api,
    loaderEvent.loaderApi,
    loaderEvent.pipeline_id,
    loaderEvent.pipelineId,
  ) !== null;
  const outputBoundaryPresent = Object.keys(outputEvent).length > 0;
  const runtimeTracePresent = topLevelRuntimeTracePresent
    || (dispatchBoundaryPresent && loaderBoundaryPresent && outputBoundaryPresent);
  const evidenceRefs = compactStringList(evidenceObjects.flatMap((value) => evidenceRefsFromValue(value)));
  const failedGates = compactStringList([
    runtimeTracePresent ? null : 'native_runtime_trace_missing',
    dispatchBoundaryPresent ? null : 'native_runtime_dispatch_boundary_missing',
    loaderBoundaryPresent ? null : 'native_runtime_loader_boundary_missing',
    outputBoundaryPresent ? null : 'native_runtime_output_boundary_missing',
    evidenceRefs.length > 0 ? null : 'native_runtime_trace_evidence_refs_missing',
  ]);
  return {
    accepted: failedGates.length === 0,
    runtimeTracePresent,
    runtime_trace_present: runtimeTracePresent,
    dispatchBoundaryPresent,
    dispatch_boundary_present: dispatchBoundaryPresent,
    loaderBoundaryPresent,
    loader_boundary_present: loaderBoundaryPresent,
    outputBoundaryPresent,
    output_boundary_present: outputBoundaryPresent,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    failedGates: failedGates.map((code) => ({ code })),
    failed_gates: failedGates.map((code) => ({ code })),
  };
}

function fullRuntimeEvidenceAuthorityFacet(row = {}) {
  const strictRuntimeArtifactAccepted = row.runtimeProofArtifact?.accepted === true;
  const ledgerAccepted =
    row.ledger?.present === true
    && row.ledger?.source === 'recomputed_ledger'
    && row.ledger?.gpuHmrSuccess === true
    && Array.isArray(row.ledger?.failedInvariants)
    && row.ledger.failedInvariants.length === 0;
  const computeOracleAccepted =
    row.outputOracleFacet?.kind === 'compute_oracle'
    && row.outputOracleFacet?.accepted === true;
  const visualOracleAccepted = row.visual?.required === true && row.visual?.accepted === true;
  const outputOracleAccepted = computeOracleAccepted || visualOracleAccepted;
  const nativeRuntimeTrace = nativeRuntimeTraceEvidenceFacet(row);
  const nativeRuntimeAuthorityAccepted =
    ledgerAccepted
    && row.proofChainAccepted === true
    && outputOracleAccepted
    && nativeRuntimeTrace.accepted === true;
  const accepted = strictRuntimeArtifactAccepted;
  const failedGates = accepted
    ? []
    : compactStringList([
      ledgerAccepted ? null : 'full_runtime_authority_recomputed_ledger_missing',
      row.proofChainAccepted === true ? null : 'full_runtime_authority_proof_chain_not_accepted',
      outputOracleAccepted ? null : 'full_runtime_authority_output_oracle_not_accepted',
      nativeRuntimeTrace.accepted === true
        ? null
        : 'full_runtime_authority_native_runtime_trace_missing',
      strictRuntimeArtifactAccepted ? null : 'full_runtime_authority_strict_runtime_proof_artifact_missing',
      'full_runtime_authority_requires_strict_runtime_proof_artifact',
    ]);
  return {
    accepted,
    authority: strictRuntimeArtifactAccepted
      ? 'strict_runtime_proof_artifact'
      : nativeRuntimeAuthorityAccepted
        ? 'backend_native_recomputed_ledger_trace_supporting_only'
        : 'unproven',
    strictRuntimeArtifactAccepted,
    strict_runtime_artifact_accepted: strictRuntimeArtifactAccepted,
    nativeRuntimeAuthorityAccepted,
    native_runtime_authority_accepted: nativeRuntimeAuthorityAccepted,
    ledgerAccepted,
    ledger_accepted: ledgerAccepted,
    proofChainAccepted: row.proofChainAccepted === true,
    proof_chain_accepted: row.proofChainAccepted === true,
    outputOracleAccepted,
    output_oracle_accepted: outputOracleAccepted,
    computeOracleAccepted,
    compute_oracle_accepted: computeOracleAccepted,
    visualOracleAccepted,
    visual_oracle_accepted: visualOracleAccepted,
    nativeRuntimeTrace,
    native_runtime_trace: nativeRuntimeTrace,
    failedGates: failedGates.map((code) => ({ code })),
    failed_gates: failedGates.map((code) => ({ code })),
  };
}

function rowSafetyFailures(row) {
  const failures = [];
  const acceptanceScope = firstText(row.acceptanceScope, row.acceptance_scope);
  const declaredAcceptanceScope = firstText(
    row.declaredAcceptanceScope,
    row.declared_acceptance_scope,
  );
  const broadScopeDeclared =
    acceptanceScope === BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE
    || declaredAcceptanceScope === BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE;
  const broadScopeProven = broadLibraryAgnosticScopeProven(row);
  if (row.acceptedForGpuHmr === true && row.matrixOutcome !== 'full_runtime_gpu_hmr') {
    failures.push({ code: 'gpu_hmr_success_requires_full_runtime_outcome' });
  }
  if (row.acceptedForGpuHmr === true && broadScopeDeclared && broadScopeProven !== true) {
    failures.push({ code: 'gpu_hmr_success_requires_broad_library_agnostic_scope_proof' });
  }
  if (
    row.acceptedForGpuHmr === true
    && !(
      SCOPED_FULL_RUNTIME_ACCEPTANCE_SCOPES.has(acceptanceScope)
      || (acceptanceScope === BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE && broadScopeProven === true)
    )
  ) {
    failures.push({ code: 'gpu_hmr_success_requires_known_acceptance_scope' });
  }
  if (row.acceptedForGpuHmr === true && row.proofChainAccepted !== true) {
    failures.push({ code: 'gpu_hmr_success_requires_accepted_proof_chain' });
  }
  if (row.acceptedForGpuHmr === true) {
    if (row.gpuHmrSuccess !== true) {
      failures.push({ code: 'accepted_gpu_hmr_row_requires_gpu_hmr_success_true' });
    }
    if (row.refusalProven === true || row.refusal_proven === true) {
      failures.push({ code: 'accepted_gpu_hmr_row_cannot_be_refusal_proven' });
    }
    failures.push(...generalityClaimFailures(row));
    failures.push(...fullRuntimeLedgerAuthorityFailures(row));
    const fullRuntimeAuthority = fullRuntimeEvidenceAuthorityFacet(row);
    if (fullRuntimeAuthority.accepted !== true) {
      failures.push(...fullRuntimeAuthority.failedGates);
    }
    if (row.runtimeProofArtifact?.accepted !== true) {
      failures.push({ code: 'gpu_hmr_success_requires_strict_runtime_proof_artifact' });
    }
    const sourceAdaptation = sourceAdaptationProofFacet(row);
    if (sourceAdaptation.acceptedForNoShimHmr !== true) {
      failures.push(...sourceAdaptation.failedGates);
    }
    const noShimSourceIdentity = noShimSourceIdentityFacet(row);
    if (noShimSourceIdentity.accepted !== true) {
      failures.push(...compactObjectList(noShimSourceIdentity.failedGates ?? noShimSourceIdentity.failed_gates));
    }
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
    && row.visual?.required === true
    && (
      row.visual.requireDeclaredHashes !== true
      || row.visual.requireDiff !== true
      || row.visual.allRequiredHashesDeclared !== true
      || row.visual.allDeclaredHashesContentAddressed !== true
      || row.visual.allDeclaredHashesMatch !== true
      || row.visual.beforeHashDeclared !== true
      || row.visual.afterHashDeclared !== true
      || row.visual.diffHashDeclared !== true
      || row.visual.hasDiffImage !== true
    )
  ) {
    failures.push({ code: 'visual_gpu_hmr_success_requires_content_addressed_visual_oracle' });
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
    const sameProcessOracleGate = realRocmSameProcessRuntimeOracleGate({
      realRocmSameProcessRuntimeOracle: compactObject(
        row.realRocmSameProcessRuntimeOracle
        ?? row.real_rocm_same_process_runtime_oracle
        ?? row.sameProcessRuntimeOracle
        ?? row.same_process_runtime_oracle,
      ),
      realRocmAppHookContractGate: appHookGate,
      runtimeProofArtifactGate: compactObject(
        row.runtimeProofArtifact
        ?? row.runtime_proof_artifact,
      ),
    });
    if (sameProcessOracleGate.required && !sameProcessOracleGate.accepted) {
      failures.push({
        code: sameProcessOracleGate.present
          ? 'gpu_hmr_success_requires_proven_same_process_runtime_oracle'
          : 'gpu_hmr_success_requires_same_process_runtime_oracle_contract',
      });
    }
    const runtimeCapabilityPreflight = compactObject(
      row.realRocmRuntimeCapabilityPreflight
      ?? row.real_rocm_runtime_capability_preflight
      ?? row.runtimeCapabilityPreflight
      ?? row.runtime_capability_preflight,
    );
    if (runtimeCapabilityPreflight.present !== true) {
      failures.push({
        code: 'gpu_hmr_success_requires_real_rocm_runtime_capability_preflight',
      });
    } else if (runtimeCapabilityPreflight.accepted !== true) {
      failures.push({
        code: 'gpu_hmr_success_cannot_have_failed_real_rocm_runtime_capability_preflight',
      });
    }
    const runtimeChain = compactObject(
      row.realRocmRuntimeChain
      ?? row.real_rocm_runtime_chain
      ?? row.runtimeChain
      ?? row.runtime_chain,
    );
    if (runtimeChain.accepted !== true) {
      failures.push({ code: 'gpu_hmr_success_requires_real_rocm_runtime_chain' });
    }
  }
  if (row.matrixOutcome === 'refusal_proven' && row.acceptedForGpuHmr === true) {
    failures.push({ code: 'refusal_row_cannot_accept_gpu_hmr' });
  }
  if (row.matrixOutcome === 'preflight_only' && row.acceptedForGpuHmr === true) {
    failures.push({ code: 'preflight_only_row_cannot_accept_gpu_hmr' });
  }
  if (row.proofMode === 'runtime_preflight') {
    const backend = firstText(row.backend);
    const backendEvidenceAccepted = preflightBackendEvidenceAccepted(row);
    if (row.acceptedForGpuHmr === true) {
      failures.push({ code: 'runtime_preflight_row_cannot_accept_gpu_hmr' });
    }
    if (row.gpuHmrSuccess === true) {
      failures.push({ code: 'runtime_preflight_row_cannot_report_gpu_hmr_success' });
    }
    if (row.matrixOutcome === 'full_runtime_gpu_hmr') {
      failures.push({ code: 'runtime_preflight_row_cannot_be_full_runtime_gpu_hmr' });
    }
    if (backend && backend !== 'unknown' && backendEvidenceAccepted !== true) {
      failures.push({ code: 'preflight_backend_specific_classification_requires_typed_backend_evidence' });
    }
    if (row.matrixOutcome === 'preflight_only' && backendEvidenceAccepted !== true) {
      failures.push({ code: 'preflight_only_requires_typed_backend_evidence' });
    }
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

function visualEvidenceInputsFromValue(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => visualEvidenceInputsFromValue(item));
  if (isObject(value)) return [value];
  return [];
}

async function runtimeProofRow(json, filePath, context) {
  const contract = compactObject(json.acceptanceContract ?? json.acceptance_contract);
  const classification = compactObject(contract.classification);
  const artifactIdentity = compactObject(contract.artifact_identity ?? contract.artifactIdentity);
  const ledger = ledgerFacet(json);
  const runtimeProofArtifactRaw = runtimeProofArtifactFromValue(json);
  const runtimeProofArtifactGate = runtimeProofArtifactFacet(runtimeProofArtifactRaw);
  const proofLedger = compactObject(
    json.proofLedger
    ?? json.proof_ledger
    ?? runtimeProofArtifactRaw.proofLedger
    ?? runtimeProofArtifactRaw.proof_ledger,
  );
  const ledgerRecord = compactObject(proofLedger.records?.[0]);
  const sourceAdaptation = sourceAdaptationProofFacet(
    json,
    runtimeProofArtifactRaw,
    ledgerRecord,
    ledger.record,
    contract,
  );
  const resultState = firstText(json.resultState, json.result_state);
  const baseAccepted =
    json.gpuHmrSuccess === true
    && json.fullRuntimeProven === true
    && resultState === 'gpu-hmr-full-runtime-proven'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && runtimeProofArtifactGate.accepted === true
    && sourceAdaptation.acceptedForNoShimHmr === true;
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
  const visualInputs = [
    ...visualEvidenceInputsFromValue(json.visualEvidenceArtifacts ?? json.visual_evidence_artifacts),
    ...visualEvidenceInputsFromValue(json.visualEvidenceRefs ?? json.visual_evidence_refs),
    ...artifactPathsFromValue(
      oracleArtifacts.visual_oracle_artifacts
      ?? oracleArtifacts.visualOracleArtifacts
      ?? oracleArtifacts.compute_oracle_artifacts
    ?? oracleArtifacts.computeOracleArtifacts,
  ).filter((item) => item.endsWith('.png')),
  ];
  const visual = await visualArtifactEvidence(
    visualInputs,
    context.repoRoot,
    path.dirname(filePath),
    {},
    outputKind === 'visual_oracle' ? runtimeVisualOracleEvidenceRequirements() : false,
  );
  const outputOracleFacet = await realRocmLedgerOutputOracleFacet(
    ledger,
    proofLedger,
    visual,
    context.repoRoot,
    path.dirname(filePath),
  );
  const accepted = baseAccepted && outputOracleFacet.accepted === true;
  const outputOracleFailureCodes = (outputOracleFacet.failedGates ?? [])
    .map((failure) => compactObject(failure).code);
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
    proofIds: proofIdsFrom(json, ledger, runtimeProofArtifactRaw),
    ledger,
    acceptanceContract: contract,
    acceptance_contract: contract,
    artifactAfterHash: firstText(ledgerRecord.artifactAfterHash, ledgerRecord.artifact_after_hash),
    artifact_after_hash: firstText(ledgerRecord.artifactAfterHash, ledgerRecord.artifact_after_hash),
    artifactBeforeHash: firstText(ledgerRecord.artifactBeforeHash, ledgerRecord.artifact_before_hash),
    artifact_before_hash: firstText(ledgerRecord.artifactBeforeHash, ledgerRecord.artifact_before_hash),
    runtimeProofArtifact: runtimeProofArtifactGate,
    runtime_proof_artifact: runtimeProofArtifactGate,
    outputOracleFacet,
    output_oracle_facet: outputOracleFacet,
    sourceAdaptation,
    source_adaptation: sourceAdaptation,
    sourceAdaptedProfile: sourceAdaptation.sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptation.sourceAdaptedProfile,
    visual,
    runMode,
    cpuHmrUsed,
    fullRebuildUsed,
    processRestarted,
    reasons: accepted ? [] : compactStringList([
      json.degradedReason,
      ...(Array.isArray(json.limitations) ? json.limitations.map((item) => item?.degradedReason ?? item?.degraded_reason ?? item) : []),
      runtimeProofArtifactGate.accepted === true ? null : 'runtime_proof_artifact_not_strictly_accepted',
      ...runtimeProofArtifactGate.failedGates.map((failure) => failure.code),
      outputOracleFacet.accepted === true ? null : 'output_oracle_artifacts_not_accepted',
      outputOracleFacet.kind === 'compute_oracle' && outputOracleFacet.accepted !== true
        ? 'compute_oracle_files_not_accepted'
        : null,
      outputOracleFacet.kind === 'visual_oracle' && outputOracleFacet.accepted !== true
        ? 'visual_oracle_artifacts_not_accepted'
        : null,
      ...outputOracleFailureCodes,
      sourceAdaptation.sourceAdaptedProfile ? 'source_adapted_profile_not_no_shim_gpu_hmr' : null,
      ...ledger.failedInvariants.map((failure) => failure.code),
    ]),
    openGaps: accepted ? [] : compactStringList([
      'runtime_proof_not_accepted',
      runtimeProofArtifactGate.accepted === true ? null : 'runtime_proof_artifact_not_strictly_accepted',
      ...runtimeProofArtifactGate.failedGates.map((failure) => failure.code),
      outputOracleFacet.accepted === true ? null : 'output_oracle_artifacts_not_accepted',
      outputOracleFacet.kind === 'compute_oracle' && outputOracleFacet.accepted !== true
        ? 'compute_oracle_files_not_accepted'
        : null,
      outputOracleFacet.kind === 'visual_oracle' && outputOracleFacet.accepted !== true
        ? 'visual_oracle_artifacts_not_accepted'
        : null,
      ...outputOracleFailureCodes,
      ...sourceAdaptation.failedGates.map((failure) => failure.code),
    ]),
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
  const runtimeProofArtifact = runtimeProofArtifactFromValue(waitDetail ?? {});
  const recomputedLedger = runModeLedgerFacet(waitDetail ?? {}, runtimeProofArtifact);
  const runtimeProofArtifactGate = runtimeProofArtifactFacet(runtimeProofArtifact);
  const sourceAdaptation = sourceAdaptationProofFacet(
    waitDetail,
    runtimeProofArtifact,
    recomputedLedger.record,
  );
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
    runtimeVisualOracleEvidenceRequirements(),
  );
  const strictRuntimeProofAccepted =
    recomputedLedger.present === true
    && recomputedLedger.source === 'recomputed_ledger'
    && recomputedLedger.gpuHmrSuccess === true
    && recomputedLedger.failedInvariants.length === 0
    && runtimeProofArtifactGate.present === true
    && runtimeProofArtifactGate.accepted === true;
  const strictPreviewProofAccepted =
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
    && strictRuntimeProofAccepted
    && firewall.cpuHmrUsed === false
    && firewall.fullRebuildUsed === false
    && firewall.processRestarted === false
    && identity.targetId !== 'unknown'
    && deltaRecord?.status === 'pass'
    && visual.accepted === true;
  const accepted =
    strictPreviewProofAccepted === true
    && sourceAdaptation.acceptedForNoShimHmr === true;
  const sourceAdaptedVisualProfileAccepted =
    strictPreviewProofAccepted === true
    && sourceAdaptation.sourceAdaptedProfile === true;
  const embeddedLedgerValidation = {
    present: Boolean(ledgerValidation.proofId),
    source: 'embedded_validation_claim',
    proofId: firstText(ledgerValidation.proofId),
    gpuHmrSuccess: boolOrNull(ledgerValidation.gpuHmrSuccess),
    failedInvariants: Array.isArray(ledgerValidation.failedInvariants)
      ? ledgerValidation.failedInvariants
      : [],
  };
  const ledger = recomputedLedger.present === true ? recomputedLedger : embeddedLedgerValidation;
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
    matrixOutcome: accepted
      ? 'full_runtime_gpu_hmr'
      : sourceAdaptedVisualProfileAccepted
        ? 'visual_profile_accepted'
        : 'unproven',
    acceptanceClass: accepted
      ? 'full_runtime_gpu_hmr'
      : sourceAdaptedVisualProfileAccepted
        ? 'source_adapted_visual_profile_not_no_shim_hmr'
        : 'mcp_preview_rejected',
    acceptedForGpuHmr: accepted,
    visualProfileAccepted: sourceAdaptedVisualProfileAccepted,
    visual_profile_accepted: sourceAdaptedVisualProfileAccepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted || sourceAdaptedVisualProfileAccepted,
    proofChain: accepted
      ? 'mcp_wait_hmr_runtime_proof_gate'
      : sourceAdaptedVisualProfileAccepted
        ? 'source_adapted_visual_profile_not_no_shim_hmr'
        : 'mcp_wait_hmr_runtime_proof_gate_rejected',
    proofIds: proofIdsFrom(
      ledgerValidation.proofId,
      ledger.proofId,
      runtimeProofArtifactGate.proofId,
      waitDetail?.gpu_proof_telemetry?.proofId,
      waitDetail?.gpu_proof_telemetry?.proof_id,
    ),
    ledger,
    acceptanceContract: compactObject(
      runtimeProofArtifact.acceptanceContract
      ?? runtimeProofArtifact.acceptance_contract,
    ),
    acceptance_contract: compactObject(
      runtimeProofArtifact.acceptanceContract
      ?? runtimeProofArtifact.acceptance_contract,
    ),
    artifactAfterHash: firstText(
      recomputedLedger.record?.artifactAfterHash,
      recomputedLedger.record?.artifact_after_hash,
    ),
    artifact_after_hash: firstText(
      recomputedLedger.record?.artifactAfterHash,
      recomputedLedger.record?.artifact_after_hash,
    ),
    artifactBeforeHash: firstText(
      recomputedLedger.record?.artifactBeforeHash,
      recomputedLedger.record?.artifact_before_hash,
    ),
    artifact_before_hash: firstText(
      recomputedLedger.record?.artifactBeforeHash,
      recomputedLedger.record?.artifact_before_hash,
    ),
    runtimeProofArtifact: runtimeProofArtifactGate,
    runtime_proof_artifact: runtimeProofArtifactGate,
    sourceAdaptation,
    source_adaptation: sourceAdaptation,
    sourceAdaptedProfile: sourceAdaptation.sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptation.sourceAdaptedProfile,
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
      recomputedLedger.present === true ? null : 'mcp_preview_recomputed_proof_ledger_missing',
      recomputedLedger.source === 'recomputed_ledger' ? null : 'mcp_preview_recomputed_proof_ledger_required',
      runtimeProofArtifactGate.present === true ? null : 'mcp_preview_runtime_proof_artifact_missing',
      runtimeProofArtifactGate.accepted === true ? null : 'mcp_preview_runtime_proof_artifact_not_strictly_accepted',
      ...(Array.isArray(ledger.failedInvariants) ? ledger.failedInvariants.map((failure) => failure.code) : []),
      ...runtimeProofArtifactGate.failedGates.map((failure) => failure.code),
      sourceAdaptedVisualProfileAccepted ? 'source_adapted_profile_not_no_shim_gpu_hmr' : null,
      visual.accepted ? null : 'visual_artifacts_not_readable',
    ]),
    openGaps: accepted ? [] : compactStringList([
      'mcp_runtime_visual_proof_not_accepted',
      ...sourceAdaptation.failedGates.map((failure) => failure.code),
    ]),
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
  const runtimeProbeInstrumentation = runtimeProbeInstrumentationDisclosureFacet(
    json.runtimeProbeInstrumentation,
    json.runtime_probe_instrumentation,
    runtimeProofArtifact.runtimeProbeInstrumentation,
    runtimeProofArtifact.runtime_probe_instrumentation,
  );
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
    [
      {
        role: 'before',
        path: baseline.localCapturePath,
        contentHash: firstText(
          baseline.contentHash,
          baseline.content_hash,
          baseline.localCaptureHash,
          baseline.local_capture_hash,
          baseline.localCaptureSha256,
          baseline.local_capture_sha256,
        ),
      },
      {
        role: 'after',
        path: changed.localCapturePath,
        contentHash: firstText(
          changed.contentHash,
          changed.content_hash,
          changed.localCaptureHash,
          changed.local_capture_hash,
          changed.localCaptureSha256,
          changed.local_capture_sha256,
        ),
      },
      {
        role: 'diff',
        path: diff.path,
        contentHash: firstText(
          diff.contentHash,
          diff.content_hash,
          diff.diffHash,
          diff.diff_hash,
          diff.diffSha256,
          diff.diff_sha256,
        ),
      },
    ],
    context.repoRoot,
    path.dirname(filePath),
    {
      changedPixelRatio: diff.changedPixelRatioThreshold4,
      meanAbsDelta8bit: diff.meanAbsDelta8bit,
      visualProofThresholds:
        json.visualProofThresholds
        ?? json.visual_proof_thresholds
        ?? json.thresholds
        ?? diff.visualProofThresholds
        ?? diff.visual_proof_thresholds
        ?? diff.thresholds,
    },
    runtimeVisualOracleEvidenceRequirements(),
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
  const sourceAdaptedProfile =
    compactStringList(
      runtimeProbeInstrumentation.sourceAdaptations
      ?? runtimeProbeInstrumentation.source_adaptations,
    ).length > 0
    || runtimeProbeInstrumentation.adaptedOrAlreadyPresent === true
    || runtimeProbeInstrumentation.adapted_or_already_present === true;
  const strictVisualProfileAccepted =
    json.accepted === true
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && runtimeProofArtifactProof.present === true
    && acceptance.strictProvenance === true
    && acceptance.sameProcessRuntime === true
    && acceptance.visualDelta === true
    && oracleRegionAccepted === true
    && changed.sameProcess === true
    && visual.accepted === true
    && runtimeProbeInstrumentation.accepted === true
    && cpuHmrUsed === false
    && fullRebuildUsed === false
    && processRestarted === false;
  const strictVisualProofAccepted =
    strictVisualProfileAccepted === true
    && runtimeProofArtifactProof.accepted === true
    && strict.fullRuntimeProven === true
    && strict.strictFullRuntimePassed === true;
  const accepted =
    strictVisualProofAccepted === true
    && sourceAdaptedProfile === false;
  const sourceAdaptedVisualProfileAccepted =
    strictVisualProfileAccepted === true
    && sourceAdaptedProfile === true;
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
    matrixOutcome: accepted
      ? 'full_runtime_gpu_hmr'
      : sourceAdaptedVisualProfileAccepted
        ? 'visual_profile_accepted'
        : blankRegionRefusal
          ? 'refusal_proven'
          : 'unproven',
    acceptanceClass: accepted
      ? 'full_runtime_gpu_hmr'
      : sourceAdaptedVisualProfileAccepted
        ? 'source_adapted_visual_profile_not_no_shim_hmr'
        : blankRegionRefusal
          ? 'hiprt_visual_blank_region_refusal'
          : 'hiprt_runtime_rejected',
    acceptedForGpuHmr: accepted,
    visualProfileAccepted: sourceAdaptedVisualProfileAccepted,
    visual_profile_accepted: sourceAdaptedVisualProfileAccepted,
    gpuHmrSuccess: accepted,
    refusalProven: blankRegionRefusal,
    proofChainAccepted: accepted || sourceAdaptedVisualProfileAccepted || blankRegionRefusal,
    proofChain: accepted
      ? 'embedded_runtime_proof_artifact_recomputed_ledger'
      : sourceAdaptedVisualProfileAccepted
        ? 'source_adapted_visual_profile_not_no_shim_hmr'
        : blankRegionRefusal
          ? 'hiprt_oracle_region_blank_refusal'
          : 'hiprt_strict_runtime_rejected',
    proofIds: proofIdsFrom(json, strict, runtimeProofArtifact, ledger),
    ledger,
    runtimeProofArtifact: runtimeProofArtifactProof,
    runtimeProbeInstrumentation,
    runtime_probe_instrumentation: runtimeProbeInstrumentation,
    sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptedProfile,
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
      sourceAdaptedVisualProfileAccepted ? 'source_adapted_profile_not_no_shim_gpu_hmr' : null,
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
      runtimeProbeInstrumentation.accepted === true
        ? null
        : 'hiprt_profile_instrumentation_disclosure_not_proven',
      ...visual.failedGates,
      ...runtimeProbeInstrumentation.failedGates,
      ...oracleRegionRecomputed.failedGates.map((failure) => failure.code),
    ]),
    openGaps: accepted
      ? []
      : sourceAdaptedVisualProfileAccepted
        ? ['source_adapted_profile_not_no_shim_gpu_hmr']
        : blankRegionRefusal
          ? ['full_runtime_gpu_hmr_not_proven_blank_oracle_region']
          : compactStringList([
              'hiprt_same_process_visual_proof_not_accepted',
              ...visual.failedGates,
            ]),
  });
}

async function webGpuRuntimeVisualRow(json, filePath, context) {
  const runtimeProofArtifact = runtimeProofArtifactFromValue(json);
  const runtimeProofArtifactGate = runtimeProofArtifactFacet(runtimeProofArtifact);
  const visualArtifacts = compactObject(
    json.visualOracleArtifacts
    ?? json.visual_oracle_artifacts
    ?? json.artifacts,
  );
  const metrics = compactObject(json.metrics);
  const visual = await visualArtifactEvidence(
    visualArtifacts,
    context.repoRoot,
    path.dirname(filePath),
    metrics,
    runtimeVisualOracleEvidenceRequirements(),
  );
  const ledger = ledgerFacet(json);
  const ledgerRecord = compactObject(json.proofLedger?.records?.[0] ?? json.proof_ledger?.records?.[0]);
  const processContinuity = compactObject(json.browser?.processContinuity);
  const nativeApiEvidence = compactObject(json.nativeWebGpuApiEvidence);
  const contract = compactObject(json.contract ?? json.acceptanceContract ?? json.acceptance_contract);
  const webgpuContract = compactObject(contract.webgpu_contract ?? contract.webgpuContract);
  const deterministicVisualModeEvaluation = evaluateGpuHmrDeterministicVisualMode(
    json.deterministicVisualMode
    ?? json.deterministic_visual_mode
    ?? runtimeProofArtifact.deterministicVisualMode
    ?? runtimeProofArtifact.deterministic_visual_mode,
  );
  const sourceAdaptation = sourceAdaptationProofFacet(
    json,
    json.runtimeProofArtifact,
    json.runtime_proof_artifact,
    ledgerRecord,
    ledger.record,
    contract,
  );
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
  const declaredScopeEvidence = declaredScopeEvidenceFacet({
    supportedPipelineScope,
    contract,
    backendContract: webgpuContract,
    profile: json.profile,
  });
  const strictVisualProofAccepted =
    json.gpuHmrSuccess === true
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && json.visualThresholdValidation?.accepted === true
    && processContinuity.accepted === true
    && processContinuity.processRestarted === false
    && nativeApiEvidence.accepted === true
    && declaredScopeEvidence.accepted === true
    && runtimeProofArtifactGate.accepted === true
    && visual.accepted === true
    && deterministicVisualModeEvaluation.accepted === true;
  const accepted =
    strictVisualProofAccepted === true
    && sourceAdaptation.acceptedForNoShimHmr === true;
  const sourceAdaptedVisualProfileAccepted =
    strictVisualProofAccepted === true
    && sourceAdaptation.sourceAdaptedProfile === true;
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
    matrixOutcome: accepted
      ? 'full_runtime_gpu_hmr'
      : sourceAdaptedVisualProfileAccepted
        ? 'visual_profile_accepted'
        : 'unproven',
    acceptanceClass: accepted
      ? 'full_runtime_gpu_hmr'
      : sourceAdaptedVisualProfileAccepted
        ? 'source_adapted_visual_profile_not_no_shim_hmr'
        : 'webgpu_runtime_visual_rejected',
    acceptedForGpuHmr: accepted,
    visualProfileAccepted: sourceAdaptedVisualProfileAccepted,
    visual_profile_accepted: sourceAdaptedVisualProfileAccepted,
    gpuHmrSuccess: accepted,
    refusalProven: false,
    proofChainAccepted: accepted || sourceAdaptedVisualProfileAccepted,
    proofChain: accepted
      ? 'webgpu_ledger_process_native_visual_chain'
      : sourceAdaptedVisualProfileAccepted
        ? 'source_adapted_visual_profile_not_no_shim_hmr'
        : 'webgpu_runtime_visual_chain_rejected',
    proofIds: proofIdsFrom(json, ledger, runtimeProofArtifact),
    ledger,
    runtimeProofArtifact: runtimeProofArtifactGate,
    runtime_proof_artifact: runtimeProofArtifactGate,
    sourceAdaptation,
    source_adaptation: sourceAdaptation,
    sourceAdaptedProfile: sourceAdaptation.sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptation.sourceAdaptedProfile,
    supportedPipelineScope,
    supported_pipeline_scope: supportedPipelineScope,
    declaredScopeEvidence,
    declared_scope_evidence: declaredScopeEvidence,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
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
      runtimeProofArtifactGate.accepted === true ? null : 'runtime_proof_artifact_not_strictly_accepted',
      declaredScopeEvidence.accepted === true ? null : 'webgpu_visual_declared_scope_not_evidence_backed',
      deterministicVisualModeEvaluation.accepted === true ? null : 'deterministic_visual_mode_not_accepted',
      sourceAdaptedVisualProfileAccepted ? 'source_adapted_profile_not_no_shim_gpu_hmr' : null,
      ...runtimeProofArtifactGate.failedGates.map((failure) => failure.code),
      ...deterministicVisualModeEvaluation.failedGates.map((failure) => failure.code),
    ]),
    openGaps: accepted ? [] : compactStringList([
      'webgpu_runtime_visual_proof_not_accepted',
      ...declaredScopeEvidence.failedGates,
      ...deterministicVisualModeEvaluation.failedGates.map((failure) => failure.code),
      ...sourceAdaptation.failedGates.map((failure) => failure.code),
    ]),
  });
}

async function webGpuRuntimeComputeRow(json, filePath, context) {
  const ledger = ledgerFacet(json);
  const runtimeProofArtifact = runtimeProofArtifactFromValue(json);
  const runtimeProofArtifactGate = runtimeProofArtifactFacet(runtimeProofArtifact);
  const proofLedger = compactObject(json.proofLedger ?? json.proof_ledger);
  const ledgerRecord = compactObject(proofLedger.records?.[0] ?? json.proofLedger?.records?.[0] ?? json.proof_ledger?.records?.[0]);
  const processContinuity = compactObject(json.browser?.processContinuity);
  const nativeApiEvidence = compactObject(json.nativeWebGpuApiEvidence);
  const contract = compactObject(json.contract ?? json.acceptanceContract ?? json.acceptance_contract);
  const webgpuContract = compactObject(contract.webgpu_contract ?? contract.webgpuContract);
  const sourceAdaptation = sourceAdaptationProofFacet(
    json,
    json.runtimeProofArtifact,
    json.runtime_proof_artifact,
    ledgerRecord,
    ledger.record,
    contract,
  );
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
  const declaredScopeEvidence = declaredScopeEvidenceFacet({
    supportedPipelineScope,
    contract,
    backendContract: webgpuContract,
    profile: json.profile,
  });
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
  const runtimeReadbackResource = compactObject(
    runtimeResourceTrace.readbackResource
    ?? runtimeResourceTrace.readback_resource,
  );
  const webGpuComputeRuntimeProfileAccepted =
    webgpuContract.pipeline_kind === 'compute'
    && Boolean(firstText(webgpuContract.compute_pipeline_trace, webgpuContract.computePipelineTrace))
    && Boolean(firstText(webgpuContract.compute_readback_trace, webgpuContract.computeReadbackTrace))
    && Boolean(firstText(webgpuContract.bind_group_layout_hash, webgpuContract.bindGroupLayoutHash))
    && Boolean(firstText(webgpuContract.pipeline_layout_hash, webgpuContract.pipelineLayoutHash))
    && Boolean(firstText(webgpuContract.pipeline_state_hash, webgpuContract.pipelineStateHash))
    && Object.keys(runtimeResourceTrace).length > 0
    && Array.isArray(runtimeResourceTrace.buffers)
    && runtimeResourceTrace.buffers.length > 0
    && finiteNumber(runtimeReadbackResource.byteLength ?? runtimeReadbackResource.byte_length) > 0;
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
    && declaredScopeEvidence.accepted === true
    && webGpuComputeRuntimeProfileAccepted === true
    && runtimeProofArtifactGate.accepted === true
    && sourceAdaptation.acceptedForNoShimHmr === true;
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
    proofIds: proofIdsFrom(json, ledger, runtimeProofArtifact),
    ledger,
    runtimeProofArtifact: runtimeProofArtifactGate,
    runtime_proof_artifact: runtimeProofArtifactGate,
    sourceAdaptation,
    source_adaptation: sourceAdaptation,
    sourceAdaptedProfile: sourceAdaptation.sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptation.sourceAdaptedProfile,
    outputOracleFacet: computeOracleFacet,
    output_oracle_facet: computeOracleFacet,
    supportedPipelineScope,
    supported_pipeline_scope: supportedPipelineScope,
    declaredScopeEvidence,
    declared_scope_evidence: declaredScopeEvidence,
    webGpuComputeRuntimeProfileAccepted,
    webgpu_compute_runtime_profile_accepted: webGpuComputeRuntimeProfileAccepted,
    expectedOutputVerified,
    expected_output_verified: expectedOutputVerified,
    expectedOutputHash: directComputeArtifacts.expected_output_hash,
    expected_output_hash: directComputeArtifacts.expected_output_hash,
    runtimeResourceTrace,
    runtime_resource_trace: runtimeResourceTrace,
    visual: {
      required: false,
      accepted: false,
      evidenceKind: 'compute_card_not_runtime_visual_oracle',
      reason: 'webgpu_compute_readback_uses_compute_card_not_runtime_frame_visual_proof',
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
      runtimeProofArtifactGate.accepted === true ? null : 'runtime_proof_artifact_not_strictly_accepted',
      sourceAdaptation.sourceAdaptedProfile ? 'source_adapted_profile_not_no_shim_gpu_hmr' : null,
      declaredScopeEvidence.accepted === true
        ? null
        : 'webgpu_compute_declared_scope_not_evidence_backed',
      webGpuComputeRuntimeProfileAccepted === true
        ? null
        : 'webgpu_compute_runtime_profile_trace_not_accepted',
      ...runtimeProofArtifactGate.failedGates.map((failure) => failure.code),
    ]),
    openGaps: accepted ? [] : compactStringList([
      'webgpu_runtime_compute_readback_proof_not_accepted',
      ...sourceAdaptation.failedGates.map((failure) => failure.code),
    ]),
  });
}

async function hipModuleRuntimeRow(json, filePath, context) {
  const ledger = ledgerFacet(json);
  const runtimeProofArtifact = runtimeProofArtifactFromValue(json);
  const runtimeProofArtifactGate = runtimeProofArtifactFacet(runtimeProofArtifact);
  const proofLedger = compactObject(json.proofLedger ?? json.proof_ledger);
  const ledgerRecord = compactObject(proofLedger.records?.[0] ?? json.proofLedger?.records?.[0] ?? json.proof_ledger?.records?.[0]);
  const contract = compactObject(json.contract ?? json.acceptanceContract ?? json.acceptance_contract);
  const hipContract = compactObject(contract.hip_contract ?? contract.hipContract);
  const sourceAdaptation = sourceAdaptationProofFacet(
    json,
    json.runtimeProofArtifact,
    json.runtime_proof_artifact,
    ledgerRecord,
    ledger.record,
    contract,
  );
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
  const declaredScopeEvidence = declaredScopeEvidenceFacet({
    supportedPipelineScope,
    contract,
    backendContract: hipContract,
    profile: json.profile,
    claimBoundary,
    requireScopedClaimBoundary: true,
  });
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
  const claimBoundaryAccepted = declaredScopeEvidence.scopedClaimBoundaryAccepted === true;
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
    && declaredScopeEvidence.accepted === true
    && claimBoundaryAccepted
    && negativeAbiRefusalAccepted
    && runtimeTimestampProofAccepted
    && epoch2ArtifactHashProofAccepted
    && computeCardOnlyProofAccepted
    && runtimeProofArtifactGate.accepted === true
    && sourceAdaptation.acceptedForNoShimHmr === true;
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
    proofIds: proofIdsFrom(json, ledger, runtimeProofArtifact),
    ledger,
    runtimeProofArtifact: runtimeProofArtifactGate,
    runtime_proof_artifact: runtimeProofArtifactGate,
    sourceAdaptation,
    source_adaptation: sourceAdaptation,
    sourceAdaptedProfile: sourceAdaptation.sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptation.sourceAdaptedProfile,
    outputOracleFacet: computeOracleFacet,
    output_oracle_facet: computeOracleFacet,
    supportedPipelineScope,
    supported_pipeline_scope: supportedPipelineScope,
    declaredScopeEvidence,
    declared_scope_evidence: declaredScopeEvidence,
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
      runtimeProofArtifactGate.accepted === true ? null : 'runtime_proof_artifact_not_strictly_accepted',
      sourceAdaptation.sourceAdaptedProfile ? 'source_adapted_profile_not_no_shim_gpu_hmr' : null,
      runtimeTrace.sameProcess === true ? null : 'same_process_not_accepted',
      runtimeTrace.processRestarted === false ? null : 'process_continuity_not_accepted',
      nativeApiEvidence.accepted === true ? null : 'native_hip_api_not_accepted',
      declaredScopeEvidence.accepted === true
        ? null
        : 'hip_module_declared_scope_not_evidence_backed',
      claimBoundaryAccepted ? null : 'hip_module_claim_boundary_not_scoped',
      negativeAbiRefusalAccepted ? null : 'hip_module_negative_abi_refusal_not_executable',
      runtimeTimestampProofAccepted ? null : 'hip_module_runtime_event_timestamps_not_observed',
      epoch2ArtifactHashProofAccepted ? null : 'hip_module_epoch2_artifact_hash_chain_not_proven',
      computeCardOnlyProofAccepted ? null : 'hip_module_compute_card_not_separated_from_visual_proof',
    ]),
    openGaps: accepted ? [] : compactStringList([
      'hip_module_runtime_readback_proof_not_accepted',
      ...sourceAdaptation.failedGates.map((failure) => failure.code),
    ]),
  });
}

async function externalProjectRow(json, filePath, context) {
  const profileId = firstText(json.profile?.id, json.profileId, path.basename(filePath).replace(/-\d+-report\.json$/, ''));
  const externalProjectContract = externalProjectContractEvidence(json);
  const backend = externalProjectContract.backend;
  const externalVisualProofArtifact = await externalVisualProofArtifactEvidence(
    json,
    context.repoRoot,
    path.dirname(filePath),
    profileId,
  );
  const externalProfileSelection = externalProfileSelectionEvidence(
    json,
    externalVisualProofArtifact,
    profileId,
  );
  const externalSourceDelta = externalSourceDeltaEvidence(json, externalVisualProofArtifact);
  const visualArtifacts = compactObject(json.visualOracleArtifacts ?? json.visual_oracle_artifacts);
  const visualDiff = compactObject(json.visualDiff ?? json.visual_diff);
  const visual = await visualArtifactEvidence(
    visualArtifacts,
    context.repoRoot,
    path.dirname(filePath),
    visualDiff,
    json.status === 'pass' ? runtimeVisualOracleEvidenceRequirements() : false,
  );
  const declaredDeterministicMode = compactObject(
    json.deterministicVisualMode
    ?? json.deterministic_visual_mode
    ?? externalVisualProofArtifact.deterministicVisualMode
    ?? externalVisualProofArtifact.deterministic_visual_mode,
  );
  const deterministicVisualModeEvaluation =
    evaluateGpuHmrDeterministicVisualMode(declaredDeterministicMode);
  const deterministicAccepted = deterministicVisualModeEvaluation.accepted === true;
  const visualProfileAccepted =
    json.status === 'pass'
    && visual.accepted === true
    && deterministicAccepted
    && externalProfileSelection.accepted === true
    && externalSourceDelta.accepted === true
    && externalVisualProofArtifact.accepted === true;
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
    externalProjectContract,
    external_project_contract: externalProjectContract,
    externalProfileSelection,
    external_profile_selection: externalProfileSelection,
    externalSourceDelta,
    external_source_delta: externalSourceDelta,
    externalVisualProofArtifact,
    external_visual_proof_artifact: externalVisualProofArtifact,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    backendEvidence: externalProjectContract,
    backend_evidence: externalProjectContract,
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
    proofIds: proofIdsFrom(json, externalVisualProofArtifact, rejection, linkedRejection.proof),
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
      deterministicAccepted ? null : 'deterministic_visual_mode_not_accepted',
      ...deterministicVisualModeEvaluation.failedGates.map((failure) => failure.code),
      externalProfileSelection.accepted === true ? null : 'external_profile_selection_not_accepted',
      externalSourceDelta.accepted === true ? null : 'external_source_delta_not_accepted',
      externalVisualProofArtifact.accepted === true ? null : 'external_visual_proof_artifact_not_accepted',
    ]),
    openGaps: visualProfileAccepted
      ? compactStringList(['full_runtime_gpu_hmr_ledger_not_present', ...externalProjectContract.failedGates])
      : refusalProven
        ? compactStringList(['full_runtime_gpu_hmr_not_proven', ...externalProjectContract.failedGates])
        : compactStringList([
          'external_profile_not_accepted',
          ...externalProjectContract.failedGates,
          ...(deterministicAccepted ? [] : ['deterministic_visual_mode_not_accepted']),
          ...deterministicVisualModeEvaluation.failedGates.map((failure) => failure.code),
          ...externalProfileSelection.failedGates,
          ...externalSourceDelta.failedGates,
          ...externalVisualProofArtifact.failedGates,
        ]),
  });
}

function normalizeExternalBackend(value) {
  const raw = text(value);
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['bevy_wgsl', 'webgpu', 'webgl', 'hip', 'hiprt', 'opencl', 'vulkan', 'wgpu'].includes(normalized)) {
    return normalized;
  }
  return normalized;
}

function externalContractCandidate(json = {}) {
  const profile = compactObject(json.profile);
  const rejection = compactObject(json.rejection);
  return compactObject(
    json.externalProjectContract
      ?? json.external_project_contract
      ?? profile.externalProjectContract
      ?? profile.external_project_contract
      ?? rejection.externalProjectContract
      ?? rejection.external_project_contract,
  );
}

function typedContractField(contract, ...fieldNames) {
  for (const fieldName of fieldNames) {
    const field = contract[fieldName];
    const value = typedValueField(field);
    if (value) {
      return {
        value,
        evidenceRefs: compactStringList(evidenceRefsFromValue(field)),
      };
    }
  }
  return {
    value: null,
    evidenceRefs: [],
  };
}

function externalProjectContractEvidence(json = {}) {
  const profile = compactObject(json.profile);
  const project = compactObject(profile.project);
  const rejection = compactObject(json.rejection);
  const supplied = externalContractCandidate(json);
  const schemaVersion = firstText(supplied.schemaVersion, supplied.schema);
  const suppliedBackend = typedContractField(supplied, 'backend', 'gpuBackend', 'gpu_backend');
  const suppliedBackendFamily = typedContractField(supplied, 'backendFamily', 'backend_family');
  const suppliedLibraryFamily = typedContractField(supplied, 'libraryFamily', 'library_family');
  const suppliedRuntimeEnvironment = typedContractField(supplied, 'runtimeEnvironment', 'runtime_environment');
  const suppliedProfileClass = typedContractField(supplied, 'profileClass', 'profile_class');
  const profileManifestHash = firstText(
    supplied.profileManifestHash,
    supplied.profile_manifest_hash,
    supplied.manifestHash,
    supplied.manifest_hash,
  );
  const runtimeEvidenceRefs = compactStringList([
    ...evidenceRefsFromValue(supplied.runtimeEvidence),
    ...evidenceRefsFromValue(supplied.runtime_evidence),
    ...evidenceRefsFromValue(supplied.runtimeFailureArtifact),
    ...evidenceRefsFromValue(supplied.runtime_failure_artifact),
    ...evidenceRefsFromValue(supplied.visualProofArtifact),
    ...evidenceRefsFromValue(supplied.visual_proof_artifact),
    ...evidenceRefsFromValue(supplied.rejectionProofArtifact),
    ...evidenceRefsFromValue(supplied.rejection_proof_artifact),
  ]);
  const topEvidenceRefs = compactStringList(evidenceRefsFromValue(supplied));
  const arbitraryLibraryAccepted = firstBool(
    supplied.arbitraryLibraryAccepted,
    supplied.arbitrary_library_accepted,
  );
  const arbitraryTargetRuntimeAccepted = firstBool(
    supplied.arbitraryTargetRuntimeAccepted,
    supplied.arbitrary_target_runtime_accepted,
  );
  const explicitBackend = firstText(
    json.backend,
    json.gpu_backend,
    json.gpuBackend,
    json.render_backend,
    json.renderBackend,
    json.shader_backend,
    json.shaderBackend,
    profile.backend,
    profile.gpu_backend,
    profile.gpuBackend,
    profile.render_backend,
    profile.renderBackend,
    profile.shader_backend,
    profile.shaderBackend,
    project.backend,
    project.gpu_backend,
    project.gpuBackend,
    project.render_backend,
    project.renderBackend,
    rejection.backend,
    rejection.gpu_backend,
    rejection.gpuBackend,
  );
  const backendFamily = firstText(
    json.backendFamily,
    json.backend_family,
    profile.backendFamily,
    profile.backend_family,
    project.backendFamily,
    project.backend_family,
    rejection.backendFamily,
    rejection.backend_family,
  );
  const libraryFamily = firstText(
    json.libraryFamily,
    json.library_family,
    profile.libraryFamily,
    profile.library_family,
    project.libraryFamily,
    project.library_family,
    rejection.libraryFamily,
    rejection.library_family,
  );
  const runtimeEnvironment = firstText(
    json.runtimeEnvironment,
    json.runtime_environment,
    profile.runtimeEnvironment,
    profile.runtime_environment,
    project.runtimeEnvironment,
    project.runtime_environment,
    rejection.runtimeEnvironment,
    rejection.runtime_environment,
  );
  const profileClass = firstText(
    json.profileClass,
    json.profile_class,
    profile.profileClass,
    profile.profile_class,
    project.profileClass,
    project.profile_class,
    rejection.profileClass,
    rejection.profile_class,
  );
  const backend = normalizeExternalBackend(suppliedBackend.value);
  const accepted = Boolean(
    schemaVersion === 'synthi.gpu_hmr.external_project_contract.v2'
    && supplied.accepted === true
    && backend
    && suppliedBackendFamily.value
    && suppliedLibraryFamily.value
    && suppliedRuntimeEnvironment.value
    && suppliedProfileClass.value
    && suppliedBackend.evidenceRefs.length > 0
    && suppliedBackendFamily.evidenceRefs.length > 0
    && suppliedLibraryFamily.evidenceRefs.length > 0
    && suppliedRuntimeEnvironment.evidenceRefs.length > 0
    && suppliedProfileClass.evidenceRefs.length > 0
    && contentAddressedSha256(profileManifestHash)
    && topEvidenceRefs.length > 0
    && runtimeEvidenceRefs.length > 0
    && arbitraryLibraryAccepted === false
    && arbitraryTargetRuntimeAccepted === false
  );
  const failedGates = compactStringList([
    Object.keys(supplied).length > 0 ? null : 'external_contract_evidence_missing',
    schemaVersion === 'synthi.gpu_hmr.external_project_contract.v2'
      ? null
      : 'external_contract_schema_missing',
    supplied.accepted === true ? null : 'external_contract_not_explicitly_accepted',
    backend ? null : 'external_backend_metadata_missing',
    suppliedBackendFamily.value ? null : 'external_backend_family_missing',
    suppliedLibraryFamily.value ? null : 'external_library_family_missing',
    suppliedRuntimeEnvironment.value ? null : 'external_runtime_environment_missing',
    suppliedProfileClass.value ? null : 'external_profile_class_missing',
    suppliedBackend.evidenceRefs.length > 0 ? null : 'external_backend_field_evidence_refs_missing',
    suppliedBackendFamily.evidenceRefs.length > 0 ? null : 'external_backend_family_field_evidence_refs_missing',
    suppliedLibraryFamily.evidenceRefs.length > 0 ? null : 'external_library_family_field_evidence_refs_missing',
    suppliedRuntimeEnvironment.evidenceRefs.length > 0 ? null : 'external_runtime_environment_field_evidence_refs_missing',
    suppliedProfileClass.evidenceRefs.length > 0 ? null : 'external_profile_class_field_evidence_refs_missing',
    contentAddressedSha256(profileManifestHash) ? null : 'external_profile_manifest_hash_missing',
    topEvidenceRefs.length > 0 ? null : 'external_contract_evidence_refs_missing',
    runtimeEvidenceRefs.length > 0 ? null : 'external_contract_runtime_evidence_refs_missing',
    arbitraryLibraryAccepted === false ? null : 'external_contract_cannot_claim_arbitrary_library_acceptance',
    arbitraryTargetRuntimeAccepted === false ? null : 'external_contract_cannot_claim_arbitrary_target_acceptance',
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.external_project_contract_evidence.v1',
    accepted,
    backend: backend ?? 'unknown',
    rawBackend: explicitBackend ?? null,
    raw_backend: explicitBackend ?? null,
    backendFamily: suppliedBackendFamily.value ?? null,
    backend_family: suppliedBackendFamily.value ?? null,
    libraryFamily: suppliedLibraryFamily.value ?? null,
    library_family: suppliedLibraryFamily.value ?? null,
    runtimeEnvironment: suppliedRuntimeEnvironment.value ?? null,
    runtime_environment: suppliedRuntimeEnvironment.value ?? null,
    profileClass: suppliedProfileClass.value ?? null,
    profile_class: suppliedProfileClass.value ?? null,
    profileManifestHash: profileManifestHash ?? null,
    profile_manifest_hash: profileManifestHash ?? null,
    evidenceRefs: topEvidenceRefs,
    evidence_refs: topEvidenceRefs,
    runtimeEvidenceRefs,
    runtime_evidence_refs: runtimeEvidenceRefs,
    authority: accepted ? 'typed_external_project_contract_v2' : 'missing_typed_external_project_contract_v2',
    failedGates,
    failed_gates: failedGates,
  };
}

function externalProfileSelectionEvidence(json = {}, linkedProof = {}, expectedProfileId = null) {
  const supplied = compactObject(
    json.profileSelection
      ?? json.profile_selection
      ?? linkedProof.profileSelection
      ?? linkedProof.profile_selection,
  );
  const schemaVersion = firstText(supplied.schemaVersion, supplied.schema);
  const profileId = firstText(supplied.profileId, supplied.profile_id, supplied.id);
  const manifestHash = firstText(supplied.manifestHash, supplied.manifest_hash);
  const evidenceRefs = evidenceRefsFromValue(supplied);
  const accepted = Boolean(
    schemaVersion === 'synthi.gpu.hmr.external_profile_selection.v1'
    && supplied.accepted === true
    && supplied.explicit === true
    && profileId
    && (!expectedProfileId || profileId === expectedProfileId)
    && contentAddressedSha256(manifestHash)
    && firstText(supplied.source)
    && evidenceRefs.length > 0,
  );
  const failedGates = compactStringList([
    schemaVersion === 'synthi.gpu.hmr.external_profile_selection.v1'
      ? null
      : 'external_profile_selection_schema_missing',
    supplied.accepted === true ? null : 'external_profile_selection_not_accepted',
    supplied.explicit === true ? null : 'external_profile_selection_not_explicit',
    profileId ? null : 'external_profile_selection_profile_id_missing',
    !expectedProfileId || profileId === expectedProfileId
      ? null
      : 'external_profile_selection_profile_id_mismatch',
    contentAddressedSha256(manifestHash) ? null : 'external_profile_selection_manifest_hash_missing',
    firstText(supplied.source) ? null : 'external_profile_selection_source_missing',
    evidenceRefs.length > 0 ? null : 'external_profile_selection_evidence_refs_missing',
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.external_profile_selection_evidence.v1',
    accepted,
    present: Object.keys(supplied).length > 0,
    profileId,
    profile_id: profileId,
    source: firstText(supplied.source),
    manifestHash,
    manifest_hash: manifestHash,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    failedGates,
    failed_gates: failedGates,
  };
}

function externalSourceDeltaEvidence(json = {}, linkedProof = {}) {
  const supplied = compactObject(
    json.sourceDeltaEvidence
      ?? json.source_delta_evidence
      ?? linkedProof.sourceDeltaEvidence
      ?? linkedProof.source_delta_evidence,
  );
  const schemaVersion = firstText(supplied.schemaVersion, supplied.schema);
  const matchCount = finiteNumber(supplied.matchCount ?? supplied.match_count);
  const beforeFileHash = firstText(supplied.beforeFileHash, supplied.before_file_hash);
  const afterFileHash = firstText(supplied.afterFileHash, supplied.after_file_hash);
  const beforeSnippetHash = firstText(supplied.beforeSnippetHash, supplied.before_snippet_hash);
  const afterSnippetHash = firstText(supplied.afterSnippetHash, supplied.after_snippet_hash);
  const sourceFile = firstText(supplied.sourceFile, supplied.source_file, supplied.sourcePath, supplied.source_path);
  const byteRange = compactObject(supplied.byteRange ?? supplied.byte_range);
  const evidenceRefs = evidenceRefsFromValue(supplied);
  const accepted = Boolean(
    schemaVersion === 'synthi.gpu.hmr.external_source_delta_evidence.v1'
    && supplied.accepted === true
    && matchCount === 1
    && sourceFile
    && contentAddressedSha256(beforeFileHash)
    && contentAddressedSha256(afterFileHash)
    && beforeFileHash !== afterFileHash
    && contentAddressedSha256(beforeSnippetHash)
    && contentAddressedSha256(afterSnippetHash)
    && beforeSnippetHash !== afterSnippetHash
    && Number.isFinite(byteRange.start)
    && Number.isFinite(byteRange.end)
    && byteRange.end > byteRange.start
    && evidenceRefs.length > 0,
  );
  const failedGates = compactStringList([
    schemaVersion === 'synthi.gpu.hmr.external_source_delta_evidence.v1'
      ? null
      : 'external_source_delta_schema_missing',
    supplied.accepted === true ? null : 'external_source_delta_not_accepted',
    matchCount === 1 ? null : 'external_source_delta_unique_match_missing',
    sourceFile ? null : 'external_source_delta_source_file_missing',
    contentAddressedSha256(beforeFileHash) ? null : 'external_source_delta_before_hash_missing',
    contentAddressedSha256(afterFileHash) ? null : 'external_source_delta_after_hash_missing',
    beforeFileHash && afterFileHash && beforeFileHash !== afterFileHash
      ? null
      : 'external_source_delta_file_hash_unchanged',
    contentAddressedSha256(beforeSnippetHash) ? null : 'external_source_delta_before_snippet_hash_missing',
    contentAddressedSha256(afterSnippetHash) ? null : 'external_source_delta_after_snippet_hash_missing',
    beforeSnippetHash && afterSnippetHash && beforeSnippetHash !== afterSnippetHash
      ? null
      : 'external_source_delta_snippet_hash_unchanged',
    Number.isFinite(byteRange.start) && Number.isFinite(byteRange.end) && byteRange.end > byteRange.start
      ? null
      : 'external_source_delta_byte_range_missing',
    evidenceRefs.length > 0 ? null : 'external_source_delta_evidence_refs_missing',
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.external_source_delta_evidence.v1',
    accepted,
    present: Object.keys(supplied).length > 0,
    sourceFile,
    source_file: sourceFile,
    matchCount,
    match_count: matchCount,
    beforeFileHash,
    before_file_hash: beforeFileHash,
    afterFileHash,
    after_file_hash: afterFileHash,
    beforeSnippetHash,
    before_snippet_hash: beforeSnippetHash,
    afterSnippetHash,
    after_snippet_hash: afterSnippetHash,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    failedGates,
    failed_gates: failedGates,
  };
}

async function visualPairDiffEvidence(beforePath, afterPath) {
  if (!beforePath || !afterPath) {
    return {
      accepted: false,
      failedGates: ['external_visual_pair_paths_missing'],
      failed_gates: ['external_visual_pair_paths_missing'],
    };
  }
  try {
    const before = await sharp(beforePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const after = await sharp(afterPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sameResolution =
      before.info.width === after.info.width
      && before.info.height === after.info.height
      && before.info.width > 0
      && before.info.height > 0;
    let changed = 0;
    let totalAbs = 0;
    let visiblePixelCount = 0;
    if (sameResolution) {
      for (let i = 0; i < before.data.length; i += 4) {
        const dr = Math.abs(before.data[i] - after.data[i]);
        const dg = Math.abs(before.data[i + 1] - after.data[i + 1]);
        const db = Math.abs(before.data[i + 2] - after.data[i + 2]);
        const da = Math.abs(before.data[i + 3] - after.data[i + 3]);
        const sum = dr + dg + db + da;
        if (sum > 0) changed += 1;
        if (after.data[i + 3] > 0) visiblePixelCount += 1;
        totalAbs += (dr + dg + db) / 3;
      }
    }
    const pixelCount = sameResolution ? before.info.width * before.info.height : 0;
    const changedPixelRatio = pixelCount > 0 ? changed / pixelCount : null;
    const meanAbsDelta8bit = pixelCount > 0 ? totalAbs / pixelCount : null;
    const accepted = Boolean(
      sameResolution
      && Number(changedPixelRatio) > 0
      && Number(meanAbsDelta8bit) > 0
      && visiblePixelCount > 0,
    );
    const failedGates = compactStringList([
      sameResolution ? null : 'external_visual_pair_resolution_mismatch',
      Number(changedPixelRatio) > 0 ? null : 'external_visual_pair_zero_pixel_delta',
      Number(meanAbsDelta8bit) > 0 ? null : 'external_visual_pair_zero_mean_delta',
      visiblePixelCount > 0 ? null : 'external_visual_pair_blank_after_frame',
    ]);
    return {
      accepted,
      width: sameResolution ? before.info.width : null,
      height: sameResolution ? before.info.height : null,
      changedPixelRatio,
      changed_pixel_ratio: changedPixelRatio,
      meanAbsDelta8bit,
      mean_abs_delta_8bit: meanAbsDelta8bit,
      visiblePixelCount,
      visible_pixel_count: visiblePixelCount,
      failedGates,
      failed_gates: failedGates,
    };
  } catch (err) {
    const failedGates = [`external_visual_pair_decode_failed:${err?.code ?? err?.name ?? 'unknown'}`];
    return {
      accepted: false,
      failedGates,
      failed_gates: failedGates,
    };
  }
}

function externalVisualProofArtifactCandidatePaths(json = {}) {
  const visualProofArtifact = compactObject(json.visualProofArtifact ?? json.visual_proof_artifact);
  return compactStringList([
    visualProofArtifact.path,
    visualProofArtifact.localPath,
    visualProofArtifact.local_path,
    ...(Array.isArray(json.proofArtifactPaths) ? json.proofArtifactPaths : []),
    ...(Array.isArray(json.proof_artifact_paths) ? json.proof_artifact_paths : []),
  ]);
}

async function readExternalVisualProofArtifact(proofPath, repoRoot, baseDir, expectedProfileId = null) {
  const resolved = resolveEvidencePath(proofPath, repoRoot, baseDir);
  if (!resolved) {
    return {
      present: false,
      accepted: false,
      failedGates: ['external_visual_proof_artifact_path_missing'],
      failed_gates: ['external_visual_proof_artifact_path_missing'],
    };
  }
  const json = await readJson(resolved);
  if (!isObject(json)) {
    return {
      present: false,
      accepted: false,
      path: relPath(resolved, repoRoot),
      failedGates: ['external_visual_proof_artifact_unreadable'],
      failed_gates: ['external_visual_proof_artifact_unreadable'],
    };
  }
  const proofDir = path.dirname(resolved);
  const schemaVersion = firstText(json.schemaVersion, json.schema);
  const proofId = firstText(json.proofId, json.proof_id);
  const material = { ...json };
  delete material.proofId;
  delete material.proof_id;
  const recomputedProofId = `external-visual-proof:${sha256Hex(stableJson(material))}`;
  const profileId = firstText(json.profileId, json.profile_id);
  const visualArtifacts = compactObject(json.visualOracleArtifacts ?? json.visual_oracle_artifacts);
  const requiredRolePaths = {
    before: resolveEvidencePath(visualArtifacts.before_image ?? visualArtifacts.beforeImage, repoRoot, proofDir),
    after: resolveEvidencePath(visualArtifacts.after_image ?? visualArtifacts.afterImage, repoRoot, proofDir),
    diff: resolveEvidencePath(visualArtifacts.diff_image ?? visualArtifacts.diffImage, repoRoot, proofDir),
  };
  const requiredPaths = Object.values(requiredRolePaths).filter(Boolean);
  const contentHashes = [];
  for (const imagePath of requiredPaths) {
    contentHashes.push(await fileSha256Hash(imagePath));
  }
  const requiredContentHashes = compactStringList(contentHashes);
  const visualEvidenceArtifacts = compactObjectList(json.visualEvidenceArtifacts ?? json.visual_evidence_artifacts);
  const acceptedArtifactHashes = new Set(visualEvidenceArtifacts
    .filter((artifact) =>
      artifact.acceptedAsVisualEvidence === true
      && artifact.accepted_as_visual_evidence === true
      && !visualEvidenceIsSupplementalOnly(artifact)
      && !artifact.readError
      && !artifact.read_error
      && !artifact.visualAnalysisError
      && !artifact.visual_analysis_error
    )
    .map((artifact) => firstText(artifact.contentHash, artifact.content_hash))
    .filter(contentAddressedSha256));
  const allRequiredHashesAccepted =
    requiredContentHashes.length === requiredPaths.length
    && requiredContentHashes.length >= 3
    && requiredContentHashes.every((hash) => acceptedArtifactHashes.has(hash));
  const visualDiff = await visualPairDiffEvidence(requiredRolePaths.before, requiredRolePaths.after);
  const deterministicVisualMode = compactObject(
    json.deterministicVisualMode
    ?? json.deterministic_visual_mode,
  );
  const deterministicVisualModeEvaluation =
    evaluateGpuHmrDeterministicVisualMode(deterministicVisualMode);
  const deterministicAccepted = deterministicVisualModeEvaluation.accepted === true;
  const mcpPreviewRequiresFullProof = firstText(json.proofMode, json.proof_mode) === 'mcp_preview';
  const mcpPreviewFullProofAccepted = !mcpPreviewRequiresFullProof;
  const accepted = Boolean(
    schemaVersion === 'synthi.gpu.hmr.external_visual_proof_artifact.v1'
    && json.status === 'pass'
    && proofId
    && proofId === recomputedProofId
    && profileId
    && (!expectedProfileId || profileId === expectedProfileId)
    && allRequiredHashesAccepted
    && visualDiff.accepted === true
    && deterministicAccepted
    && mcpPreviewFullProofAccepted,
  );
  const failedGates = compactStringList([
    schemaVersion === 'synthi.gpu.hmr.external_visual_proof_artifact.v1'
      ? null
      : 'external_visual_proof_artifact_schema_missing',
    json.status === 'pass' ? null : 'external_visual_proof_artifact_status_not_pass',
    proofId ? null : 'external_visual_proof_artifact_proof_id_missing',
    proofId && proofId === recomputedProofId ? null : 'external_visual_proof_artifact_proof_id_hash_mismatch',
    profileId ? null : 'external_visual_proof_artifact_profile_id_missing',
    !expectedProfileId || profileId === expectedProfileId
      ? null
      : 'external_visual_proof_artifact_profile_id_mismatch',
    requiredPaths.length >= 3 ? null : 'external_visual_proof_artifact_required_images_missing',
    allRequiredHashesAccepted ? null : 'external_visual_proof_artifact_required_hashes_not_accepted',
    visualDiff.accepted === true ? null : 'external_visual_proof_artifact_pair_diff_not_accepted',
    deterministicAccepted ? null : 'external_visual_proof_artifact_deterministic_mode_not_accepted',
    ...deterministicVisualModeEvaluation.failedGates.map((failure) => failure.code),
    mcpPreviewFullProofAccepted ? null : 'external_visual_proof_artifact_mcp_preview_full_runtime_proof_missing',
    ...visualDiff.failedGates,
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.external_visual_proof_artifact_evidence.v1',
    present: true,
    accepted,
    path: relPath(resolved, repoRoot),
    proofId,
    proof_id: proofId,
    recomputedProofId,
    recomputed_proof_id: recomputedProofId,
    profileId,
    profile_id: profileId,
    status: json.status ?? null,
    requiredContentHashes,
    required_content_hashes: requiredContentHashes,
    acceptedArtifactHashCount: acceptedArtifactHashes.size,
    accepted_artifact_hash_count: acceptedArtifactHashes.size,
    visualDiff,
    visual_diff: visualDiff,
    deterministicVisualMode,
    deterministic_visual_mode: deterministicVisualMode,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    deterministicAccepted,
    deterministic_accepted: deterministicAccepted,
    profileSelection: compactObject(json.profileSelection ?? json.profile_selection),
    profile_selection: compactObject(json.profileSelection ?? json.profile_selection),
    sourceDeltaEvidence: compactObject(json.sourceDeltaEvidence ?? json.source_delta_evidence),
    source_delta_evidence: compactObject(json.sourceDeltaEvidence ?? json.source_delta_evidence),
    failedGates,
    failed_gates: failedGates,
  };
}

async function externalVisualProofArtifactEvidence(json = {}, repoRoot, baseDir, expectedProfileId = null) {
  const paths = externalVisualProofArtifactCandidatePaths(json);
  if (paths.length === 0) {
    return {
      schemaVersion: 'synthi.gpu_hmr.external_visual_proof_artifact_evidence.v1',
      present: false,
      accepted: false,
      failedGates: ['external_visual_proof_artifact_path_missing'],
      failed_gates: ['external_visual_proof_artifact_path_missing'],
    };
  }
  const attempts = [];
  for (const candidatePath of paths) {
    const attempt = await readExternalVisualProofArtifact(candidatePath, repoRoot, baseDir, expectedProfileId);
    attempts.push(attempt);
    if (attempt.accepted === true) return attempt;
  }
  const firstPresent = attempts.find((attempt) => attempt.present === true) ?? attempts[0];
  return {
    schemaVersion: 'synthi.gpu_hmr.external_visual_proof_artifact_evidence.v1',
    ...firstPresent,
    accepted: false,
    failedGates: compactStringList(attempts.flatMap((attempt) => attempt.failedGates)),
    failed_gates: compactStringList(attempts.flatMap((attempt) => attempt.failedGates)),
  };
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
  const externalProjectContract = externalProjectContractEvidence(json);
  const backend = externalProjectContract.backend;
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
    externalProjectContract,
    external_project_contract: externalProjectContract,
    backendEvidence: externalProjectContract,
    backend_evidence: externalProjectContract,
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
    openGaps: refusalProven
      ? compactStringList(['full_runtime_gpu_hmr_not_proven', ...externalProjectContract.failedGates])
      : compactStringList(['external_rejection_artifact_not_accepted', ...externalProjectContract.failedGates]),
  });
}

function evidenceRefList(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => evidenceRefList(item));
  if (isObject(value)) return evidenceRefsFromValue(value);
  return [];
}

function evidenceRefsFromValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => evidenceRefList(item));
  if (!isObject(value)) return [];
  return [
    value.evidenceRef,
    value.evidence_ref,
    ...evidenceRefList(value.evidenceRefs),
    ...evidenceRefList(value.evidence_refs),
    ...evidenceRefList(value.backendEvidenceRefs),
    ...evidenceRefList(value.backend_evidence_refs),
    ...evidenceRefList(value.fieldEvidenceRefs),
    ...evidenceRefList(value.field_evidence_refs),
  ];
}

function valueFieldText(value) {
  return isObject(value) ? firstText(value.value) : firstText(value);
}

function typedValueField(value) {
  return isObject(value) ? firstText(value.value) : null;
}

function preflightBackendEvidenceCandidates(json = {}) {
  const classification = compactObject(json.classification);
  const acceptance = compactObject(json.acceptance);
  const contract = compactObject(
    json.contract
    ?? json.acceptanceContract
    ?? json.acceptance_contract
    ?? classification.contract
    ?? classification.acceptanceContract
    ?? classification.acceptance_contract,
  );
  const profile = compactObject(
    json.profile
    ?? json.runtimeProfile
    ?? json.runtime_profile
    ?? classification.profile
    ?? classification.runtimeProfile
    ?? classification.runtime_profile,
  );
  const runtimeCapability = compactObject(
    json.runtimeCapability
    ?? json.runtime_capability
    ?? json.runtimeCapabilityPreflight
    ?? json.runtime_capability_preflight
    ?? classification.runtimeCapability
    ?? classification.runtime_capability
    ?? classification.runtimeCapabilityPreflight
    ?? classification.runtime_capability_preflight
    ?? acceptance.runtimeCapability
    ?? acceptance.runtime_capability
    ?? acceptance.runtimeCapabilityPreflight
    ?? acceptance.runtime_capability_preflight,
  );
  return [
    ['backend_evidence', compactObject(json.backendEvidence ?? json.backend_evidence)],
    ['preflight_backend_evidence', compactObject(
      json.preflightBackendEvidence ?? json.preflight_backend_evidence,
    )],
    ['backend_contract', compactObject(json.backendContract ?? json.backend_contract)],
    ['contract', contract],
    ['classification', classification],
    ['profile', profile],
    ['runtime_capability', runtimeCapability],
    ['artifact', compactObject(json)],
  ].filter(([, candidate]) => Object.keys(candidate).length > 0);
}

function backendEvidenceFromCandidate(source, candidate) {
  const schemaVersion = firstText(candidate.schemaVersion, candidate.schema);
  const backendField = candidate.backend ?? candidate.gpuBackend ?? candidate.gpu_backend;
  const backendFamilyField = candidate.backendFamily ?? candidate.backend_family;
  const profile = compactObject(candidate.profile ?? candidate.runtimeProfile ?? candidate.runtime_profile);
  const runtimeCapability = compactObject(
    candidate.runtimeCapability
    ?? candidate.runtime_capability
    ?? candidate.runtimeCapabilityPreflight
    ?? candidate.runtime_capability_preflight,
  );
  const backendRaw = firstText(
    typedValueField(backendField),
    typedValueField(profile.backend ?? profile.gpuBackend ?? profile.gpu_backend),
    typedValueField(runtimeCapability.backend ?? runtimeCapability.gpuBackend ?? runtimeCapability.gpu_backend),
  );
  const backendFamilyRaw = firstText(
    typedValueField(backendFamilyField),
    typedValueField(profile.backendFamily ?? profile.backend_family),
    typedValueField(runtimeCapability.backendFamily ?? runtimeCapability.backend_family),
  );
  const backendFieldEvidenceRefs = compactStringList([
    ...evidenceRefsFromValue(backendField),
    ...evidenceRefsFromValue(profile.backend ?? profile.gpuBackend ?? profile.gpu_backend),
    ...evidenceRefsFromValue(runtimeCapability.backend ?? runtimeCapability.gpuBackend ?? runtimeCapability.gpu_backend),
  ]);
  const backendFamilyFieldEvidenceRefs = compactStringList([
    ...evidenceRefsFromValue(backendFamilyField),
    ...evidenceRefsFromValue(profile.backendFamily ?? profile.backend_family),
    ...evidenceRefsFromValue(runtimeCapability.backendFamily ?? runtimeCapability.backend_family),
  ]);
  const backend = backendRaw && backendRaw !== 'unknown' ? backendRaw : null;
  const backendFamily = backendFamilyRaw && backendFamilyRaw !== 'unknown' ? backendFamilyRaw : null;
  const evidenceRefs = compactStringList([
    ...evidenceRefsFromValue(candidate),
    ...evidenceRefsFromValue(backendField),
    ...evidenceRefsFromValue(backendFamilyField),
    ...evidenceRefsFromValue(profile),
    ...evidenceRefsFromValue(runtimeCapability),
  ]);
  const runtimeProbe = firstText(
    runtimeCapability.probe,
    runtimeCapability.probeId,
    runtimeCapability.probe_id,
    runtimeCapability.probeCommand,
    runtimeCapability.probe_command,
  );
  const failedGates = compactStringList([
    schemaVersion === 'synthi.gpu_hmr.preflight_backend_contract.v1'
      ? null
      : 'preflight_backend_contract_schema_missing',
    backend ? null : 'preflight_backend_value_missing',
    backendFamily ? null : 'preflight_backend_family_missing',
    backendFieldEvidenceRefs.length > 0 ? null : 'preflight_backend_field_evidence_refs_missing',
    backendFamilyFieldEvidenceRefs.length > 0 ? null : 'preflight_backend_family_field_evidence_refs_missing',
    runtimeProbe ? null : 'preflight_backend_probe_identity_missing',
    evidenceRefs.length > 0 ? null : 'preflight_backend_evidence_refs_missing',
  ]);
  return {
    source,
    schemaVersion,
    schema_version: schemaVersion,
    backend,
    backendFamily,
    backend_family: backendFamily,
    runtimeProbe,
    runtime_probe: runtimeProbe,
    backendFieldEvidenceRefs,
    backend_field_evidence_refs: backendFieldEvidenceRefs,
    backendFamilyFieldEvidenceRefs,
    backend_family_field_evidence_refs: backendFamilyFieldEvidenceRefs,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    accepted: failedGates.length === 0,
    failedGates: failedGates.map((code) => ({ code })),
    failed_gates: failedGates.map((code) => ({ code })),
  };
}

function preflightBackendEvidenceFacet(json = {}) {
  const candidates = preflightBackendEvidenceCandidates(json)
    .map(([source, candidate]) => backendEvidenceFromCandidate(source, candidate));
  const accepted = candidates.find((candidate) => candidate.accepted === true);
  const best = accepted
    ?? candidates.find((candidate) => candidate.backend && candidate.backendFamily)
    ?? candidates.find((candidate) => candidate.backend)
    ?? candidates[0]
    ?? backendEvidenceFromCandidate('missing', {});
  const failedGates = accepted
    ? []
    : compactStringList(best.failedGates?.map((gate) => gate.code));
  return {
    schemaVersion: 'synthi.gpu_hmr.preflight_backend_evidence.v1',
    accepted: accepted !== undefined,
    source: best.source,
    backend: accepted ? accepted.backend : null,
    backendFamily: accepted ? accepted.backendFamily : (best.backendFamily ?? null),
    backend_family: accepted ? accepted.backendFamily : (best.backendFamily ?? null),
    evidenceRefs: accepted ? accepted.evidenceRefs : compactStringList(best.evidenceRefs),
    evidence_refs: accepted ? accepted.evidenceRefs : compactStringList(best.evidenceRefs),
    failedGates: failedGates.map((code) => ({ code })),
    failed_gates: failedGates.map((code) => ({ code })),
  };
}

function preflightBackendEvidenceAccepted(row = {}) {
  const existing = compactObject(row.backendEvidence ?? row.backend_evidence);
  if (existing.accepted === true) return true;
  const evidence = preflightBackendEvidenceFacet(row);
  return evidence.accepted === true;
}

function preflightAcceptedField(backend, acceptance) {
  if (backend === 'oidn_hip') {
    return acceptance.acceptedForOidnHipOutputProof === true
      || (
        acceptance.acceptedForHipOutputProof === true
        && acceptance.outputOracleObservedAfterDispatch === true
      );
  }
  if (backend === 'opencl') return acceptance.acceptedForOpenClOutputProof === true;
  if (backend === 'vulkan') return acceptance.acceptedForVulkanPipelineProof === true;
  if (backend === 'webgpu') return acceptance.acceptedForWebGpuPipelineProof === true;
  return false;
}

function preflightRuntimeOnlyAccepted(backend, acceptance) {
  if (backend === 'oidn_hip') return acceptance.acceptedForOidnHipRuntimePreflight === true;
  if (backend === 'webgpu') return acceptance.acceptedForWebGpuRuntimePreflight === true;
  if (backend === 'opencl') return acceptance.acceptedForOpenClRuntimePreflight === true;
  if (backend === 'vulkan') return acceptance.acceptedForVulkanRuntimePreflight === true;
  return false;
}

function preflightRuntimeOnlyOpenGaps(backend) {
  if (backend === 'oidn_hip') return ['oidn_output_oracle_not_proven'];
  if (backend === 'opencl') return ['opencl_dispatch_readback_output_oracle_not_proven'];
  if (backend === 'vulkan') return ['vulkan_pipeline_frame_output_not_proven'];
  if (backend === 'webgpu') return ['shader_pipeline_or_output_oracle_not_proven'];
  return ['runtime_preflight_output_oracle_not_proven'];
}

async function preflightRow(json, filePath, context) {
  const schema = firstText(json.schema, json.schemaVersion) ?? 'unknown';
  const backendEvidence = preflightBackendEvidenceFacet(json);
  const backend = backendEvidence.accepted ? backendEvidence.backend : 'unknown';
  const acceptance = compactObject(json.acceptance);
  const classification = compactObject(json.classification);
  const proofAccepted = backendEvidence.accepted
    ? preflightAcceptedField(backend, acceptance)
    : false;
  const runtimeOnlyAccepted = backendEvidence.accepted
    ? preflightRuntimeOnlyAccepted(backend, acceptance)
    : false;
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
    evidenceKind: runtimeOnlyAccepted || backend === 'webgpu'
      ? 'runtime_preflight_diagnostic'
      : 'runtime_preflight_refusal',
    backendEvidence,
    backend_evidence: backendEvidence,
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
      backendEvidence.accepted ? null : 'preflight_typed_backend_evidence_required',
      ...backendEvidence.failedGates.map((gate) => gate.code),
      ...unsupportedReasons,
      acceptance.reason,
      proofAccepted ? 'preflight_does_not_prove_required_output_or_pipeline' : null,
    ]),
    openGaps: matrixOutcome === 'preflight_only'
      ? preflightRuntimeOnlyOpenGaps(backend)
      : refusalProven
        ? compactStringList([
          backendEvidence.accepted ? null : 'preflight_typed_backend_evidence_required',
          backend === 'opencl' ? 'real_opencl_vendor_icd_required' : null,
          backend === 'vulkan' ? 'real_vulkan_icd_required' : null,
          backend === 'oidn_hip' ? 'matching_oidn_hip_runtime_required' : null,
        ])
        : compactStringList([
          backendEvidence.accepted ? null : 'preflight_typed_backend_evidence_required',
          'runtime_preflight_not_accepted',
        ]),
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

function realRocmSourceDeltaFallbackFile(profile = {}) {
  const target = compactObject(profile.target);
  return firstText(target.deltaFile, target.delta_file, target.entryFile, target.entry_file) ?? '';
}

function realRocmSourceDeltaEntryFile(entry = {}, profile = {}) {
  return firstText(entry.file, entry.path, realRocmSourceDeltaFallbackFile(profile)) ?? '';
}

function realRocmSourceDeltaEntryConfiguredExecutableCandidate(entry = {}, profile = {}) {
  const before = text(entry.before);
  const after = text(entry.after);
  return Boolean(realRocmSourceDeltaEntryFile(entry, profile) && before && after && before !== after);
}

function realRocmSourceDeltaEntryKind(entry = {}) {
  return firstText(
    entry.kind,
    entry.editKind,
    entry.edit_kind,
    entry.label,
  )?.toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/[-.]+/g, '_')
    || '';
}

function realRocmSourceDeltaExecutionPhaseKind(entry = {}) {
  const raw = firstText(
    entry.phaseKind,
    entry.phase_kind,
    entry.kind,
    entry.editKind,
    entry.edit_kind,
    entry.label,
    entry.metricScope,
    entry.metric_scope,
  ) ?? '';
  const normalized = raw.toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/[-.]+/g, '_');
  if (
    normalized === 'hot_delta_2'
    || normalized === 'hot2'
    || normalized === 'second'
    || normalized.includes('hot_delta_2')
  ) {
    return 'hot_delta_2';
  }
  if (normalized === 'negative_edit' || normalized === 'negative' || normalized.includes('negative')) {
    return 'negative_edit';
  }
  if (
    normalized === 'hot_delta_1'
    || normalized === 'primary'
    || normalized.includes('hot_delta_1')
  ) {
    return 'hot_delta_1';
  }
  return normalized || 'source_delta';
}

function realRocmSourceDeltaExecutionFacet(raw = {}) {
  const source = compactObject(raw);
  const phases = compactObjectList(source.phases ?? source.phaseRows ?? source.phase_rows);
  const normalizedPhases = phases.map((phase, index) => {
    const phaseKind = realRocmSourceDeltaExecutionPhaseKind(phase);
    const editHash = firstText(phase.editHash, phase.edit_hash);
    const sourceBeforeHash = firstText(phase.sourceBeforeHash, phase.source_before_hash);
    const sourceAfterHash = firstText(phase.sourceAfterHash, phase.source_after_hash);
    const sourceWriteObserved =
      phase.sourceWriteObserved === true
      || phase.source_write_observed === true;
    const compileCallAttempted =
      phase.compileCallAttempted === true
      || phase.compile_call_attempted === true;
    const phaseExecuted =
      sourceWriteObserved
      && compileCallAttempted
      && contentAddressedSha256(editHash);
    return {
      index,
      label: firstText(phase.label, phase.phaseName, phase.phase_name) ?? `phase-${index + 1}`,
      phaseName: firstText(phase.phaseName, phase.phase_name) ?? null,
      phase_name: firstText(phase.phaseName, phase.phase_name) ?? null,
      phaseKind,
      phase_kind: phaseKind,
      metricScope: firstText(phase.metricScope, phase.metric_scope) ?? null,
      metric_scope: firstText(phase.metricScope, phase.metric_scope) ?? null,
      file: firstText(phase.file, phase.path) ?? null,
      editHash: editHash ?? null,
      edit_hash: editHash ?? null,
      sourceBeforeHash: sourceBeforeHash ?? null,
      source_before_hash: sourceBeforeHash ?? null,
      sourceAfterHash: sourceAfterHash ?? null,
      source_after_hash: sourceAfterHash ?? null,
      sourceWriteObserved,
      source_write_observed: sourceWriteObserved,
      compileCallAttempted,
      compile_call_attempted: compileCallAttempted,
      compileCallCompleted:
        phase.compileCallCompleted === true
        || phase.compile_call_completed === true,
      compile_call_completed:
        phase.compileCallCompleted === true
        || phase.compile_call_completed === true,
      hmrWaitStatus: firstText(phase.hmrWaitStatus, phase.hmr_wait_status) ?? null,
      hmr_wait_status: firstText(phase.hmrWaitStatus, phase.hmr_wait_status) ?? null,
      expectedRefusal: phase.expectedRefusal === true || phase.expected_refusal === true,
      expected_refusal: phase.expectedRefusal === true || phase.expected_refusal === true,
      phaseExecuted,
      phase_executed: phaseExecuted,
    };
  });
  const hotDelta2PhaseExecuted = normalizedPhases.some((phase) =>
    phase.phaseKind === 'hot_delta_2' && phase.phaseExecuted === true
  );
  const negativeEditPhaseExecuted = normalizedPhases.some((phase) =>
    phase.phaseKind === 'negative_edit' && phase.phaseExecuted === true
  );
  const primaryHotDeltaPhaseExecuted = normalizedPhases.some((phase) =>
    phase.phaseKind === 'hot_delta_1' && phase.phaseExecuted === true
  );
  const schemaVersion = firstText(source.schemaVersion, source.schema_version, source.schema);
  const present = Object.keys(source).length > 0;
  const failedGates = compactStringList([
    !present ? 'source_delta_execution_missing' : null,
    present && schemaVersion !== REAL_ROCM_SOURCE_DELTA_EXECUTION_SCHEMA_VERSION
      ? 'source_delta_execution_schema_mismatch'
      : null,
    present && normalizedPhases.length === 0 ? 'source_delta_execution_phases_missing' : null,
    ...normalizedPhases.flatMap((phase) => [
      contentAddressedSha256(phase.editHash)
        ? null
        : `source_delta_execution_edit_hash_missing_or_invalid:${phase.label}`,
      contentAddressedSha256(phase.sourceBeforeHash)
        ? null
        : `source_delta_execution_before_hash_missing_or_invalid:${phase.label}`,
      contentAddressedSha256(phase.sourceAfterHash)
        ? null
        : `source_delta_execution_after_hash_missing_or_invalid:${phase.label}`,
      phase.sourceWriteObserved ? null : `source_delta_execution_source_write_missing:${phase.label}`,
      phase.compileCallAttempted ? null : `source_delta_execution_compile_call_missing:${phase.label}`,
    ]),
  ]);
  return {
    schemaVersion: REAL_ROCM_SOURCE_DELTA_EXECUTION_SCHEMA_VERSION,
    present,
    accepted: failedGates.length === 0,
    proofId: firstText(source.proofId, source.proof_id) ?? null,
    proof_id: firstText(source.proofId, source.proof_id) ?? null,
    proofAuthority: 'matrix_recomputed_runner_phase_evidence',
    proof_authority: 'matrix_recomputed_runner_phase_evidence',
    phaseCount: normalizedPhases.length,
    phase_count: normalizedPhases.length,
    executedPhaseCount: normalizedPhases.filter((phase) => phase.phaseExecuted).length,
    executed_phase_count: normalizedPhases.filter((phase) => phase.phaseExecuted).length,
    primaryHotDeltaPhaseExecuted,
    primary_hot_delta_phase_executed: primaryHotDeltaPhaseExecuted,
    hotDelta2PhaseExecuted,
    hot_delta_2_phase_executed: hotDelta2PhaseExecuted,
    negativeEditPhaseExecuted,
    negative_edit_phase_executed: negativeEditPhaseExecuted,
    phases: normalizedPhases,
    failedGates,
    failed_gates: failedGates,
  };
}

function realRocmSourceDeltaFixtures(profile = {}, sourceDeltaExecution = {}, serialized = {}) {
  const sourceDelta = compactObject(profile.sourceDelta ?? profile.source_delta);
  const serializedFacet = compactObject(serialized);
  const serializedFixtures = compactObject(
    serializedFacet.sourceDeltaFixtures
    ?? serializedFacet.source_delta_fixtures
    ?? serializedFacet,
  );
  const second = compactObject(sourceDelta.second ?? sourceDelta.secondDelta ?? sourceDelta.second_delta);
  const extraDeltas = Array.isArray(sourceDelta.extraDeltas)
    ? sourceDelta.extraDeltas
    : Array.isArray(sourceDelta.extra_deltas)
      ? sourceDelta.extra_deltas
      : [];
  const executableExtraDeltas = extraDeltas.filter((entry) =>
    realRocmSourceDeltaEntryConfiguredExecutableCandidate(entry, profile)
  );
  const hotDelta2Extras = executableExtraDeltas.filter((entry) => {
    const kind = realRocmSourceDeltaEntryKind(entry);
    return kind === 'hot_delta_2'
      || kind === 'hot2'
      || kind === 'second'
      || kind.includes('hot_delta_2');
  });
  const negativeEditExtras = executableExtraDeltas.filter((entry) => {
    const kind = realRocmSourceDeltaEntryKind(entry);
    return kind === 'negative_edit'
      || kind === 'negative'
      || kind.includes('negative')
      || entry.expectedRefusal === true
      || entry.expected_refusal === true;
  });
  const secondDeclared = realRocmSourceDeltaEntryConfiguredExecutableCandidate(second, profile);
  const serializedHotDelta2Declared = firstBool(
    serializedFixtures.hotDelta2Declared,
    serializedFixtures.hot_delta_2_declared,
  );
  const serializedSecondDeltaDeclared = firstBool(
    serializedFixtures.secondDeltaDeclared,
    serializedFixtures.second_delta_declared,
  );
  const serializedNegativeEditDeclared = firstBool(
    serializedFixtures.negativeEditDeclared,
    serializedFixtures.negative_edit_declared,
  );
  const serializedHotDelta2FixtureCount = finiteNumber(
    serializedFixtures.hotDelta2FixtureCount
    ?? serializedFixtures.hot_delta_2_fixture_count,
  );
  const serializedNegativeEditFixtureCount = finiteNumber(
    serializedFixtures.negativeEditFixtureCount
    ?? serializedFixtures.negative_edit_fixture_count,
  );
  const serializedExecutableExtraDeltaCount = finiteNumber(
    serializedFixtures.executableExtraDeltaCount
    ?? serializedFixtures.executable_extra_delta_count,
  );
  const serializedFixtureConfigurationPresent = Boolean(
    serializedHotDelta2Declared === true
    || serializedSecondDeltaDeclared === true
    || serializedNegativeEditDeclared === true
    || Number(serializedHotDelta2FixtureCount) > 0
    || Number(serializedNegativeEditFixtureCount) > 0
    || Number(serializedExecutableExtraDeltaCount) > 0
  );
  const profileSourceDeltaPresent = Object.keys(sourceDelta).length > 0;
  const useSerializedConfiguration = !profileSourceDeltaPresent && serializedFixtureConfigurationPresent;
  const hotDelta2Declared = secondDeclared
    || hotDelta2Extras.length > 0
    || (useSerializedConfiguration && serializedHotDelta2Declared === true);
  const negativeEditDeclared = negativeEditExtras.length > 0
    || (useSerializedConfiguration && serializedNegativeEditDeclared === true);
  const execution = compactObject(sourceDeltaExecution);
  const hotDelta2PhaseExecuted =
    execution.hotDelta2PhaseExecuted === true
    || execution.hot_delta_2_phase_executed === true;
  const negativeEditPhaseExecuted =
    execution.negativeEditPhaseExecuted === true
    || execution.negative_edit_phase_executed === true;
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_source_delta_fixtures.v1',
    proofAuthority: 'profile_configuration_plus_runner_execution_evidence',
    proof_authority: 'profile_configuration_plus_runner_execution_evidence',
    hotDelta2Declared,
    hot_delta_2_declared: hotDelta2Declared,
    secondDeltaDeclared: secondDeclared || (useSerializedConfiguration && serializedSecondDeltaDeclared === true),
    second_delta_declared: secondDeclared || (useSerializedConfiguration && serializedSecondDeltaDeclared === true),
    negativeEditDeclared,
    negative_edit_declared: negativeEditDeclared,
    fallbackFile: realRocmSourceDeltaFallbackFile(profile)
      || firstText(serializedFixtures.fallbackFile, serializedFixtures.fallback_file),
    fallback_file: realRocmSourceDeltaFallbackFile(profile)
      || firstText(serializedFixtures.fallbackFile, serializedFixtures.fallback_file),
    hotDelta2PhaseExecuted,
    hot_delta_2_phase_executed: hotDelta2PhaseExecuted,
    negativeEditPhaseExecuted,
    negative_edit_phase_executed: negativeEditPhaseExecuted,
    executionProofId: firstText(execution.proofId, execution.proof_id) ?? null,
    execution_proof_id: firstText(execution.proofId, execution.proof_id) ?? null,
    executionAccepted: execution.accepted === true,
    execution_accepted: execution.accepted === true,
    profileSourceDeltaPresent,
    profile_source_delta_present: profileSourceDeltaPresent,
    serializedConfigurationUsed: useSerializedConfiguration,
    serialized_configuration_used: useSerializedConfiguration,
    executableExtraDeltaCount: useSerializedConfiguration
      ? Math.max(0, serializedExecutableExtraDeltaCount ?? 0)
      : executableExtraDeltas.length,
    executable_extra_delta_count: useSerializedConfiguration
      ? Math.max(0, serializedExecutableExtraDeltaCount ?? 0)
      : executableExtraDeltas.length,
    hotDelta2FixtureCount: useSerializedConfiguration
      ? Math.max(0, serializedHotDelta2FixtureCount ?? (hotDelta2Declared ? 1 : 0))
      : hotDelta2Extras.length + (secondDeclared ? 1 : 0),
    hot_delta_2_fixture_count: useSerializedConfiguration
      ? Math.max(0, serializedHotDelta2FixtureCount ?? (hotDelta2Declared ? 1 : 0))
      : hotDelta2Extras.length + (secondDeclared ? 1 : 0),
    negativeEditFixtureCount: useSerializedConfiguration
      ? Math.max(0, serializedNegativeEditFixtureCount ?? (negativeEditDeclared ? 1 : 0))
      : negativeEditExtras.length,
    negative_edit_fixture_count: useSerializedConfiguration
      ? Math.max(0, serializedNegativeEditFixtureCount ?? (negativeEditDeclared ? 1 : 0))
      : negativeEditExtras.length,
  };
}

function realRocmProfileProofObligationsMatrixFacet({
  profile = {},
  targetProgression = {},
  outputOracleResolution = {},
  outputOracleContract = {},
  outputOracleRuntimeProfile = {},
  appHookContract = {},
  sourceDeltaExecution = {},
  serialized = {},
  fullRuntimeProofRequired = false,
} = {}) {
  const rawProfile = compactObject(profile);
  const declared = compactObject(rawProfile.proofObligations ?? rawProfile.proof_obligations);
  const serializedFacet = compactObject(serialized);
  const serializedGaps = compactStringList([
    ...(Array.isArray(serializedFacet.blockingGaps) ? serializedFacet.blockingGaps : []),
    ...(Array.isArray(serializedFacet.blocking_gaps) ? serializedFacet.blocking_gaps : []),
  ]);
  const targetClass = firstText(
    declared.targetClass,
    declared.target_class,
    rawProfile.targetClass,
    rawProfile.target_class,
    serializedFacet.targetClass,
    serializedFacet.target_class,
  );
  const acceptanceMode = firstText(
    declared.acceptanceMode,
    declared.acceptance_mode,
    serializedFacet.acceptanceMode,
    serializedFacet.acceptance_mode,
  );
  const refusalOnly =
    acceptanceMode === 'refusal_only'
    || declared.refusalOnly === true
    || declared.refusal_only === true;
  const progressionRequired = targetProgression.required === true;
  const finalAcceptance = targetProgression.phase === 'final-acceptance';
  const requirements = Array.isArray(targetProgression.requirements)
    ? targetProgression.requirements
    : [];
  const rawDeclared = Object.keys(declared).length > 0;
  const explicitRequiresFullRuntime =
    declared.requiresFullRuntimeProof === true
    || declared.requires_full_runtime_proof === true
    || serializedFacet.requiresFullRuntimeProof === true
    || serializedFacet.requires_full_runtime_proof === true;
  const explicitRequiresOutputOracle =
    declared.requiresOutputOracle === true
    || declared.requires_output_oracle === true
    || serializedFacet.requiresOutputOracle === true
    || serializedFacet.requires_output_oracle === true;
  const explicitRequiresAppHookContract =
    declared.requiresAppHookContract === true
    || declared.requires_app_hook_contract === true
    || serializedFacet.requiresAppHookContract === true
    || serializedFacet.requires_app_hook_contract === true;
  const explicitRequiresRunModes =
    declared.requiresRunModes === true
    || declared.requires_run_modes === true;
  const explicitRequiresNegativeEdit =
    declared.requiresNegativeEdit === true
    || declared.requires_negative_edit === true;
  const largeMlFinalAcceptance =
    targetClass === 'large_rocm_ml_infrastructure'
    && finalAcceptance;
  const requiresFullRuntimeProof =
    explicitRequiresFullRuntime
    || progressionRequired
    || finalAcceptance;
  const requiresOutputOracle =
    explicitRequiresOutputOracle
    || requirements.includes('output_oracle_proven')
    || requirements.includes('raw_compute_oracle_artifacts_when_compute_only')
    || finalAcceptance;
  const requiresAppHookContract = explicitRequiresAppHookContract || largeMlFinalAcceptance;
  const requiresRunModes = explicitRequiresRunModes || largeMlFinalAcceptance;
  const requiresNegativeEdit = explicitRequiresNegativeEdit || largeMlFinalAcceptance;
  const resolution = compactObject(outputOracleResolution);
  const oracleContract = compactObject(outputOracleContract);
  const runtimeProfile = compactObject(outputOracleRuntimeProfile);
  const hookContract = compactObject(appHookContract);
  const appHookContractDeclared =
    hookContract.declared === true
    || Object.keys(hookContract).length > 0;
  const outputOraclePresent =
    resolution.contractPresent === true
    || resolution.contract_present === true
    || resolution.runtimeProfilePresent === true
    || resolution.runtime_profile_present === true
    || Object.keys(oracleContract).length > 0
    || Object.keys(runtimeProfile).length > 0;
  const sourceDeltaExecutionFacet = realRocmSourceDeltaExecutionFacet(sourceDeltaExecution);
  const sourceDeltaFixtures = realRocmSourceDeltaFixtures(
    profile,
    sourceDeltaExecutionFacet,
    serializedFacet,
  );
  const blockingGaps = compactStringList([
    ...serializedGaps,
    finalAcceptance && !rawDeclared
      ? 'proof_obligation_raw_profile_declaration_missing'
      : null,
    refusalOnly ? 'proof_obligation_refusal_only_profile' : null,
    requiresFullRuntimeProof && fullRuntimeProofRequired !== true
      ? 'proof_obligation_full_runtime_not_requested'
      : null,
    requiresOutputOracle && !outputOraclePresent
      ? refusalOnly
        ? 'proof_obligation_refusal_only_output_oracle_absent'
        : 'proof_obligation_output_oracle_profile_missing'
      : null,
    requiresAppHookContract && !appHookContractDeclared
      ? 'proof_obligation_app_hook_contract_missing'
      : null,
    requiresRunModes && !explicitRequiresRunModes
      ? 'proof_obligation_run_modes_missing'
      : null,
    requiresNegativeEdit && !explicitRequiresNegativeEdit
      ? 'proof_obligation_negative_edit_missing'
      : null,
    requiresRunModes && !sourceDeltaFixtures.hotDelta2Declared
      ? 'proof_obligation_hot_delta_2_fixture_missing'
      : null,
    requiresNegativeEdit && !sourceDeltaFixtures.negativeEditDeclared
      ? 'proof_obligation_negative_edit_fixture_missing'
      : null,
    requiresRunModes
      && sourceDeltaFixtures.hotDelta2Declared
      && !sourceDeltaFixtures.hotDelta2PhaseExecuted
      ? 'proof_obligation_hot_delta_2_phase_not_executed'
      : null,
    requiresNegativeEdit
      && sourceDeltaFixtures.negativeEditDeclared
      && !sourceDeltaFixtures.negativeEditPhaseExecuted
      ? 'proof_obligation_negative_edit_phase_not_executed'
      : null,
  ]);
  const status = blockingGaps.length === 0
    ? 'profile_proof_obligations_met'
    : 'profile_proof_obligations_unmet';
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_profile_proof_obligations_facet.v1',
    status,
    proofAuthority: 'matrix_recomputed_profile_configuration_gate_not_runtime_proof',
    proof_authority: 'matrix_recomputed_profile_configuration_gate_not_runtime_proof',
    declared: rawDeclared,
    serializedFacetPresent: Object.keys(serializedFacet).length > 0,
    serialized_facet_present: Object.keys(serializedFacet).length > 0,
    targetClass,
    target_class: targetClass,
    refusalOnly,
    refusal_only: refusalOnly,
    progressionRequired,
    progression_required: progressionRequired,
    finalAcceptance,
    final_acceptance: finalAcceptance,
    largeMlFinalAcceptance,
    large_ml_final_acceptance: largeMlFinalAcceptance,
    requiresFullRuntimeProof,
    requires_full_runtime_proof: requiresFullRuntimeProof,
    fullRuntimeProofRequested: fullRuntimeProofRequired === true,
    full_runtime_proof_requested: fullRuntimeProofRequired === true,
    requiresOutputOracle,
    requires_output_oracle: requiresOutputOracle,
    outputOraclePresent,
    output_oracle_present: outputOraclePresent,
    requiresAppHookContract,
    requires_app_hook_contract: requiresAppHookContract,
    requiresRunModes,
    requires_run_modes: requiresRunModes,
    requiresRunModesDeclared: explicitRequiresRunModes,
    requires_run_modes_declared: explicitRequiresRunModes,
    requiresNegativeEdit,
    requires_negative_edit: requiresNegativeEdit,
    requiresNegativeEditDeclared: explicitRequiresNegativeEdit,
    requires_negative_edit_declared: explicitRequiresNegativeEdit,
    sourceDeltaFixtures,
    source_delta_fixtures: sourceDeltaFixtures,
    sourceDeltaExecution: sourceDeltaExecutionFacet,
    source_delta_execution: sourceDeltaExecutionFacet,
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
}

function realRocmOutputOracleResolutionGate(outputOracleResolution = {}, { required = false } = {}) {
  const resolution = compactObject(outputOracleResolution);
  if (Object.keys(resolution).length === 0) {
    const failedGates = required ? ['real_rocm_output_oracle_resolution_missing'] : [];
    return {
      present: false,
      accepted: failedGates.length === 0,
      required,
      disabled: false,
      failedGates,
      failed_gates: failedGates,
    };
  }
  const schemaVersion = firstText(
    resolution.schemaVersion,
    resolution.schema_version,
    resolution.schema,
  );
  const requestedProfile = firstText(
    resolution.requestedProfile,
    resolution.requested_profile,
    resolution.profile,
  );
  const mode = firstText(resolution.mode);
  const selectedSource = firstText(resolution.selectedSource, resolution.selected_source);
  const disabledReason = firstText(resolution.disabledReason, resolution.disabled_reason);
  const failedReason = firstText(resolution.failedReason, resolution.failed_reason);
  const contractPresent = firstBool(resolution.contractPresent, resolution.contract_present);
  const runtimeProfilePresent = firstBool(
    resolution.runtimeProfilePresent,
    resolution.runtime_profile_present,
  );
  const runtimeProfileSynced = firstBool(
    resolution.runtimeProfileSynced,
    resolution.runtime_profile_synced,
  );
  const profileDisabled =
    requestedProfile === 'none'
    || mode === 'none'
    || Boolean(disabledReason);
  const contractMissing = contractPresent === false;
  const runtimeProfileMissing = runtimeProfilePresent === false;
  const runtimeProfileUnsynced = runtimeProfileSynced === false;
  const noSelectedSource = selectedSource === 'none' || selectedSource === null;
  const selectedSourceUnsupported =
    selectedSource !== null
    && selectedSource !== 'none'
    && !REAL_ROCM_OUTPUT_ORACLE_SELECTED_SOURCES.has(selectedSource);
  const failedGates = compactStringList([
    schemaVersion ? null : 'real_rocm_output_oracle_resolution_schema_missing',
    schemaVersion && schemaVersion !== REAL_ROCM_OUTPUT_ORACLE_RESOLUTION_SCHEMA_VERSION
      ? 'real_rocm_output_oracle_resolution_schema_unknown'
      : null,
    profileDisabled ? 'real_rocm_output_oracle_profile_disabled' : null,
    contractPresent === true ? null : 'real_rocm_output_oracle_contract_not_explicitly_present',
    contractMissing ? 'real_rocm_output_oracle_contract_missing' : null,
    runtimeProfilePresent === true ? null : 'real_rocm_output_oracle_runtime_profile_not_explicitly_present',
    runtimeProfileMissing ? 'real_rocm_output_oracle_runtime_profile_missing' : null,
    runtimeProfileSynced === true ? null : 'real_rocm_output_oracle_runtime_profile_sync_not_explicitly_proven',
    runtimeProfileUnsynced ? 'real_rocm_output_oracle_runtime_profile_not_synced' : null,
    noSelectedSource ? 'real_rocm_output_oracle_source_missing' : null,
    selectedSourceUnsupported ? 'real_rocm_output_oracle_source_unsupported' : null,
    failedReason ? `real_rocm_output_oracle_resolution_failed:${failedReason}` : null,
  ]);
  return {
    present: true,
    accepted: failedGates.length === 0,
    required,
    disabled: profileDisabled,
    schemaVersion,
    schema_version: schemaVersion,
    requestedProfile,
    requested_profile: requestedProfile,
    mode,
    selectedSource,
    selected_source: selectedSource,
    disabledReason,
    disabled_reason: disabledReason,
    failedReason,
    failed_reason: failedReason,
    contractPresent,
    contract_present: contractPresent,
    runtimeProfilePresent,
    runtime_profile_present: runtimeProfilePresent,
    runtimeProfileSynced,
    runtime_profile_synced: runtimeProfileSynced,
    failedGates,
    failed_gates: failedGates,
  };
}

function eventRuntimeSessionId(event) {
  return firstText(
    event.runtime_session_id,
    event.runtimeSessionId,
    event.runtime_session,
    event.runtimeSession,
  );
}

function eventDispatchTableEntryId(event) {
  return firstText(
    event.dispatch_table_entry_id,
    event.dispatchTableEntryId,
    event.runtime_dispatch_table_entry_id,
    event.runtimeDispatchTableEntryId,
  );
}

function eventOutputTargetId(event) {
  return firstText(
    event.output_target_id,
    event.outputTargetId,
    event.oracle_target_id,
    event.oracleTargetId,
  );
}

function eventArtifactTransport(event, record) {
  const eventTransport = compactObject(event.artifact_transport ?? event.artifactTransport);
  const recordTransport = compactObject(record.artifact_transport ?? record.artifactTransport);
  return Object.keys(eventTransport).length > 0 ? eventTransport : recordTransport;
}

function selectedArtifactTransport(event, record) {
  const transport = eventArtifactTransport(event, record);
  return firstText(
    event.selected_loader_transport,
    event.selectedLoaderTransport,
    event.loader_transport,
    event.loaderTransport,
    transport.selected_loader_transport,
    transport.selectedLoaderTransport,
    transport.loader_transport,
    transport.loaderTransport,
    transport.transport,
    transport.kind,
  );
}

function transportArtifactHash(event, record) {
  const transport = eventArtifactTransport(event, record);
  return firstText(
    transport.artifact_hash,
    transport.artifactHash,
    transport.blob_digest,
    transport.blobDigest,
    event.blob_digest,
    event.blobDigest,
  );
}

function inMemoryArtifactTransportAccepted(event, record) {
  const transport = eventArtifactTransport(event, record);
  const selectedTransport = selectedArtifactTransport(event, record);
  const selectedTransportNormalized = text(selectedTransport)?.toLowerCase() ?? '';
  const transportClass = text(firstText(
    transport.transport_class,
    transport.transportClass,
    transport.class,
  ))?.toLowerCase();
  const memoryResident = firstBool(
    transport.memory_resident,
    transport.memoryResident,
    event.memory_resident,
    event.memoryResident,
  );
  return memoryResident === true
    || transportClass === 'in_memory'
    || selectedTransportNormalized.startsWith('ram_')
    || selectedTransportNormalized.startsWith('memory_')
    || selectedTransportNormalized.startsWith('in_memory');
}

function realRocmRuntimeChainFacet({ ledger = {}, proofLedger = {} } = {}) {
  const proofLedgerRecord = compactObject(proofLedger.records?.[0] ?? proofLedger.record);
  const record = compactObject(ledger.record ?? proofLedgerRecord);
  const loaderEvent = compactObject(record.loaderEvent ?? record.loader_event);
  const epochPublishEvent = compactObject(record.epochPublishEvent ?? record.epoch_publish_event);
  const dispatchEvent = compactObject(record.dispatchEvent ?? record.dispatch_event);
  const outputEvent = compactObject(record.outputEvent ?? record.output_event);
  const retirementEvent = compactObject(record.retirementEvent ?? record.retirement_event);
  const processIdentity = compactObject(record.processIdentity ?? record.process_identity);
  const deviceIdentity = compactObject(record.deviceIdentity ?? record.device_identity);
  const artifactAfterHash = firstText(record.artifactAfterHash, record.artifact_after_hash);
  const loaderArtifactHash = firstText(loaderEvent.artifact_hash, loaderEvent.artifactHash);
  const epochArtifactHash = firstText(epochPublishEvent.artifact_hash, epochPublishEvent.artifactHash);
  const dispatchArtifactHash = firstText(dispatchEvent.artifact_hash, dispatchEvent.artifactHash);
  const outputArtifactHash = firstText(outputEvent.artifact_hash, outputEvent.artifactHash);
  const selectedTransport = selectedArtifactTransport(loaderEvent, record);
  const transportHash = transportArtifactHash(loaderEvent, record);
  const inMemoryTransportAccepted = inMemoryArtifactTransportAccepted(loaderEvent, record);
  const requiredRuntimeSessionEvidence = stringEvidenceList([
    eventRuntimeSessionId(loaderEvent),
    eventRuntimeSessionId(epochPublishEvent),
    eventRuntimeSessionId(dispatchEvent),
    eventRuntimeSessionId(outputEvent),
    eventRuntimeSessionId(processIdentity),
  ]);
  const runtimeSessionEvidence = stringEvidenceList([
    ...requiredRuntimeSessionEvidence,
    eventRuntimeSessionId(retirementEvent),
  ]);
  const runtimeSessionIds = compactStringList(runtimeSessionEvidence);
  const requiredProcessIdEvidence = stringEvidenceList([
    firstText(processIdentity.process_id, processIdentity.processId),
    firstText(loaderEvent.process_id, loaderEvent.processId),
    firstText(epochPublishEvent.process_id, epochPublishEvent.processId),
    firstText(dispatchEvent.process_id, dispatchEvent.processId),
    firstText(outputEvent.process_id, outputEvent.processId),
  ]);
  const processIdEvidence = stringEvidenceList([
    ...requiredProcessIdEvidence,
    firstText(retirementEvent.process_id, retirementEvent.processId),
  ]);
  const processIds = compactStringList(processIdEvidence);
  const requiredEpochEvidence = stringEvidenceList([
    firstEpochText(epochPublishEvent.epoch),
    firstEpochText(dispatchEvent.epoch),
    firstEpochText(outputEvent.epoch),
  ]);
  const epochs = compactStringList(requiredEpochEvidence);
  const generationEvidence = stringEvidenceList([
    firstText(epochPublishEvent.generation),
    firstText(dispatchEvent.generation),
    firstText(outputEvent.generation),
  ]);
  const generations = compactStringList(generationEvidence);
  const requiredDispatchTableEntryEvidence = stringEvidenceList([
    eventDispatchTableEntryId(epochPublishEvent),
    eventDispatchTableEntryId(dispatchEvent),
    eventDispatchTableEntryId(outputEvent),
  ]);
  const dispatchTableEntryIds = compactStringList(requiredDispatchTableEntryEvidence);
  const dispatchId = firstText(dispatchEvent.id, dispatchEvent.dispatch_id, dispatchEvent.dispatchId);
  const outputAfterDispatchId = firstText(
    outputEvent.after_dispatch_id,
    outputEvent.afterDispatchId,
    outputEvent.dispatch_id,
    outputEvent.dispatchId,
  );
  const requiredOutputTargetEvidence = stringEvidenceList([
    eventOutputTargetId(dispatchEvent),
    eventOutputTargetId(outputEvent),
  ]);
  const outputTargetEvidence = stringEvidenceList([
    ...requiredOutputTargetEvidence,
    firstText(record.outputOracleTarget, record.output_oracle_target),
  ]);
  const outputTargetIds = compactStringList(outputTargetEvidence);
  const timestamps = {
    loader: eventTimestampNs(loaderEvent),
    epochPublish: eventTimestampNs(epochPublishEvent),
    dispatch: eventTimestampNs(dispatchEvent),
    output: eventTimestampNs(outputEvent),
    retirement: eventTimestampNs(retirementEvent),
  };
  const timestampOrderAccepted =
    timestamps.loader !== null
    && timestamps.epochPublish !== null
    && timestamps.dispatch !== null
    && timestamps.output !== null
    && timestamps.loader <= timestamps.epochPublish
    && timestamps.epochPublish <= timestamps.dispatch
    && timestamps.dispatch <= timestamps.output
    && (timestamps.retirement === null || timestamps.output <= timestamps.retirement);
  const requiredArtifactHashEvidence = stringEvidenceList([
    artifactAfterHash,
    loaderArtifactHash,
    epochArtifactHash,
    dispatchArtifactHash,
    outputArtifactHash,
    transportHash,
  ]);
  const artifactHashes = compactStringList(requiredArtifactHashEvidence);
  const failedGateCodes = compactStringList([
    Object.keys(record).length > 0 ? null : 'real_rocm_runtime_chain_ledger_record_missing',
    requiredArtifactHashEvidence.length >= 6 ? null : 'real_rocm_runtime_chain_artifact_hash_missing',
    requiredArtifactHashEvidence.length >= 6 && artifactHashes.length === 1
      ? null
      : 'real_rocm_runtime_chain_artifact_hash_mismatch',
    selectedTransport ? null : 'real_rocm_runtime_chain_transport_kind_missing',
    transportHash ? null : 'real_rocm_runtime_chain_transport_hash_missing',
    inMemoryTransportAccepted
      ? null
      : 'real_rocm_runtime_chain_memory_transport_missing',
    requiredRuntimeSessionEvidence.length >= 5 ? null : 'real_rocm_runtime_chain_session_missing',
    requiredRuntimeSessionEvidence.length >= 5 && runtimeSessionIds.length === 1
      ? null
      : 'real_rocm_runtime_chain_session_mismatch',
    requiredProcessIdEvidence.length >= 5 ? null : 'real_rocm_runtime_chain_process_identity_missing',
    requiredProcessIdEvidence.length >= 5 && processIds.length === 1
      ? null
      : 'real_rocm_runtime_chain_process_identity_mismatch',
    requiredEpochEvidence.length >= 3 ? null : 'real_rocm_runtime_chain_epoch_missing',
    requiredEpochEvidence.length >= 3 && epochs.length === 1
      ? null
      : 'real_rocm_runtime_chain_epoch_mismatch',
    generationEvidence.length === 0 || generations.length === 1
      ? null
      : 'real_rocm_runtime_chain_generation_mismatch',
    dispatchId ? null : 'real_rocm_runtime_chain_dispatch_id_missing',
    dispatchId && outputAfterDispatchId === dispatchId
      ? null
      : 'real_rocm_runtime_chain_output_dispatch_mismatch',
    requiredDispatchTableEntryEvidence.length >= 3
      ? null
      : 'real_rocm_runtime_chain_dispatch_table_entry_missing',
    requiredDispatchTableEntryEvidence.length >= 3 && dispatchTableEntryIds.length === 1
      ? null
      : 'real_rocm_runtime_chain_dispatch_table_entry_mismatch',
    requiredOutputTargetEvidence.length >= 2 ? null : 'real_rocm_runtime_chain_output_target_missing',
    requiredOutputTargetEvidence.length >= 2 && outputTargetIds.length === 1
      ? null
      : 'real_rocm_runtime_chain_output_target_mismatch',
    timestampOrderAccepted ? null : 'real_rocm_runtime_chain_timestamp_order_invalid',
    record.cpuHmrUsed === false || record.cpu_hmr_used === false
      ? null
      : 'real_rocm_runtime_chain_cpu_hmr_not_false',
    record.fullRebuildUsed === false || record.full_rebuild_used === false
      ? null
      : 'real_rocm_runtime_chain_full_rebuild_not_false',
    record.processRestarted === false || record.process_restarted === false
      ? null
      : 'real_rocm_runtime_chain_process_restart_not_false',
  ]);
  const failedGates = failedGateCodes.map((code) => ({ code }));
  return {
    schemaVersion: 'synthi.gpu_hmr.real_rocm_runtime_chain.v1',
    accepted: failedGates.length === 0,
    runtimeSessionId: runtimeSessionIds[0] ?? null,
    runtime_session_id: runtimeSessionIds[0] ?? null,
    runtimeSessionIds,
    runtime_session_ids: runtimeSessionIds,
    processId: processIds[0] ?? null,
    process_id: processIds[0] ?? null,
    artifactHash: artifactAfterHash ?? null,
    artifact_hash: artifactAfterHash ?? null,
    selectedLoaderTransport: selectedTransport ?? null,
    selected_loader_transport: selectedTransport ?? null,
    transportHash: transportHash ?? null,
    transport_hash: transportHash ?? null,
    inMemoryTransportAccepted,
    in_memory_transport_accepted: inMemoryTransportAccepted,
    epoch: epochs[0] ?? null,
    generation: generations[0] ?? null,
    dispatchId: dispatchId ?? null,
    dispatch_id: dispatchId ?? null,
    dispatchTableEntryId: dispatchTableEntryIds[0] ?? null,
    dispatch_table_entry_id: dispatchTableEntryIds[0] ?? null,
    outputTargetId: outputTargetIds[0] ?? null,
    output_target_id: outputTargetIds[0] ?? null,
    deviceIdentity,
    device_identity: deviceIdentity,
    timestamps,
    failedGates,
    failed_gates: failedGates,
  };
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
  const computeRecord = ledgerRecordsFromValue(proofLedger)
    .find((record) => Object.keys(ledgerRecordComputeOracleArtifacts(record)).length > 0);
  const computeArtifacts = computeRecord ? ledgerRecordComputeOracleArtifacts(computeRecord) : {};
  if (Object.keys(computeArtifacts).length === 0) {
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
  const outputEvent = compactObject(computeRecord?.output_event ?? computeRecord?.outputEvent);
  const outputOracle = compactObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
  const declaredRawReadbackHash = firstText(
    resolvedArtifacts.raw_readback_hash,
    resolvedArtifacts.rawReadbackHash,
  );
  const schemaHash = firstText(
    enriched?.readback_schema_hash,
    enriched?.readbackSchemaHash,
    verification.readback_schema_hash,
    verification.readbackSchemaHash,
  );
  const deterministicSliceHash = firstText(
    enriched?.deterministic_slice_hash,
    enriched?.deterministicSliceHash,
    enriched?.deterministic_slice?.hash,
    enriched?.deterministicSlice?.hash,
    verification.deterministic_slice_hash,
    verification.deterministicSliceHash,
  );
  const checksumBefore = firstText(enriched?.checksum_before, enriched?.checksumBefore);
  const checksumAfter = firstText(enriched?.checksum_after, enriched?.checksumAfter);
  const outputChangeExpected =
    firstBool(enriched?.output_change_expected, enriched?.outputChangeExpected) !== false;
  const expectedOutputVerified = firstBool(
    enriched?.expected_output_verified,
    enriched?.expectedOutputVerified,
    verification.expected_output_verified,
    verification.expectedOutputVerified,
    outputEvent.expected_output_verified,
    outputEvent.expectedOutputVerified,
    outputOracle.expected_output_verified,
    outputOracle.expectedOutputVerified,
  ) === true;
  const timestampAfterDispatch = finiteNumber(
    enriched?.timestamp_after_dispatch
    ?? enriched?.timestampAfterDispatch,
  );
  const artifactEpoch = firstEpochText(enriched?.epoch, enriched?.epoch_id, enriched?.epochId);
  const outputEpoch = firstEpochText(outputEvent.epoch, outputEvent.epoch_id, outputEvent.epochId);
  const epochMatches = artifactEpoch && outputEpoch ? artifactEpoch === outputEpoch : Boolean(artifactEpoch);
  const semanticFailedGates = compactStringList([
    declaredRawReadbackHash ? null : 'compute_oracle_raw_readback_hash_declared_missing',
    schemaHash ? null : 'compute_oracle_readback_schema_hash_missing',
    deterministicSliceHash ? null : 'compute_oracle_deterministic_slice_hash_missing',
    checksumBefore ? null : 'compute_oracle_checksum_before_missing',
    checksumAfter ? null : 'compute_oracle_checksum_after_missing',
    outputChangeExpected && checksumBefore && checksumAfter && checksumBefore === checksumAfter
      ? 'compute_oracle_checksum_unchanged'
      : null,
    expectedOutputVerified ? null : 'compute_oracle_expected_output_not_verified',
    timestampAfterDispatch !== null ? null : 'compute_oracle_timestamp_after_dispatch_missing',
    artifactEpoch ? null : 'compute_oracle_epoch_missing',
    epochMatches ? null : 'compute_oracle_epoch_mismatch',
  ]).map((code) => ({ code }));
  const fileFailedGates = compactStringList([
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
  const failedGates = [...fileFailedGates, ...semanticFailedGates];
  return {
    present: true,
    accepted: failedGates.length === 0,
    source: 'matrix_verified_compute_oracle_files',
    failedGates,
    fileIntegrityAccepted: fileFailedGates.length === 0,
    file_integrity_accepted: fileFailedGates.length === 0,
    semanticAccepted: semanticFailedGates.length === 0,
    semantic_accepted: semanticFailedGates.length === 0,
    rawReadbackHash: firstText(enriched?.raw_readback_hash, enriched?.rawReadbackHash),
    rawReadbackByteLength,
    rawReadbackHashVerified: hashVerified,
    rawReadbackHashDeclared: Boolean(declaredRawReadbackHash),
    raw_readback_hash_declared: Boolean(declaredRawReadbackHash),
    readbackSchemaHash: schemaHash,
    readback_schema_hash: schemaHash,
    deterministicSliceHashVerified,
    deterministicSliceHash,
    deterministic_slice_hash: deterministicSliceHash,
    checksumBefore,
    checksum_before: checksumBefore,
    checksumAfter,
    checksum_after: checksumAfter,
    expectedOutputVerified,
    expected_output_verified: expectedOutputVerified,
    timestampAfterDispatch,
    timestamp_after_dispatch: timestampAfterDispatch,
    epoch: artifactEpoch ?? null,
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

function normalizeTargetProgressionPhase(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return {
      raw: value,
      phase: null,
      recognized: true,
      reason: 'phase_not_declared',
    };
  }
  const normalized = value.toLowerCase().replace(/[\s_]+/g, '-');
  const phase = TARGET_PROGRESSION_PHASE_ALIASES.get(normalized) ?? normalized;
  return {
    raw: value,
    phase,
    recognized: TARGET_PROGRESSION_PHASES.has(phase),
    reason: TARGET_PROGRESSION_PHASES.has(phase)
      ? null
      : 'unknown_target_progression_phase',
  };
}

function targetProgressionPhaseRequirements(phase) {
  switch (phase) {
    case 'small-oracle':
      return [
        'target_must_not_be_final_acceptance_target_when_declared',
        'output_oracle_proven',
      ];
    case 'partial-reload':
      return [
        'target_must_not_be_final_acceptance_target_when_declared',
        'source_include_backed_partial_reload_proven',
        'fission_verifier_proven',
      ];
    case 'original-host-path':
      return [
        'target_must_not_be_final_acceptance_target_when_declared',
        'dispatch_proof_proven',
        'original_host_path_attachment_proven',
        'host_preservation_proven',
      ];
    case 'final-acceptance':
      return [
        'prior_small_oracle_proven',
        'prior_partial_reload_proven',
        'prior_original_host_path_proven',
        'full_runtime_proven',
        'output_oracle_proven',
      ];
    default:
      return [];
  }
}

function normalizeTargetProgressionMetadata(targetProgression = {}, { targetName } = {}) {
  const source = compactObject(targetProgression);
  const rawPhase = firstText(
    source.phaseRaw,
    source.phase_raw,
    source.phase,
    source.targetProgressionPhase,
    source.target_progression_phase,
  );
  const normalized = normalizeTargetProgressionPhase(rawPhase);
  const target = firstText(source.targetName, source.target_name, targetName);
  const finalTarget = firstText(
    source.finalAcceptanceTarget,
    source.final_acceptance_target,
    source.finalTarget,
    source.final_target,
  );
  const nonFinalPhase = [
    'small-oracle',
    'partial-reload',
    'original-host-path',
  ].includes(normalized.phase);
  const finalTargetDeclared = Boolean(finalTarget);
  const targetMatchesFinalAcceptance =
    finalTargetDeclared && Boolean(target) && target === finalTarget;
  return {
    schemaVersion: 'synthi.real_rocm.target_progression.v1',
    required: firstBool(source.required, source.requiredForAcceptance) === true,
    phaseRaw: normalized.raw,
    phase: normalized.phase,
    recognized: normalized.recognized,
    reason: normalized.reason,
    targetName: target ?? null,
    finalAcceptanceTarget: finalTarget ?? null,
    finalAcceptanceTargetDeclared: finalTargetDeclared,
    targetMatchesFinalAcceptance,
    nonFinalPhase,
    nonFinalTargetRequired: nonFinalPhase && finalTargetDeclared,
    requirements: normalized.phase
      ? targetProgressionPhaseRequirements(normalized.phase)
      : [],
  };
}

function targetProgressionLedgerEntries(ledger) {
  if (Array.isArray(ledger)) return ledger.map(compactObject).filter((entry) => Object.keys(entry).length > 0);
  const source = compactObject(ledger);
  if (Object.keys(source).length === 0) return [];
  if (Array.isArray(source.entries)) return source.entries.map(compactObject).filter((entry) => Object.keys(entry).length > 0);
  if (Array.isArray(source.phases)) return source.phases.map(compactObject).filter((entry) => Object.keys(entry).length > 0);
  const phases = compactObject(source.phaseProofs ?? source.phase_proofs ?? source.proofs ?? source);
  const ignoredKeys = new Set(['schemaVersion', 'schema_version', 'provided', 'rawShape', 'raw_shape']);
  return Object.entries(phases)
    .filter(([key]) => !ignoredKeys.has(key))
    .map(([phase, value]) => {
      if (isObject(value)) return { phase, ...value };
      return { phase, status: value };
    })
    .map(compactObject)
    .filter((entry) => Object.keys(entry).length > 0);
}

function targetProgressionEntryStatusPassed(entry) {
  const status = String(firstText(
    entry.status,
    entry.state,
    entry.result,
    entry.resultStatus,
    entry.result_status,
  ) ?? '').toLowerCase();
  return ['pass', 'passed', 'proven', 'success', 'succeeded', 'ok'].includes(status);
}

function hasTargetProgressionStructuredProofReference(entry) {
  const source = compactObject(entry);
  const artifactRef = firstText(
    source.proofArtifactPath,
    source.proof_artifact_path,
    source.proofArtifactUri,
    source.proof_artifact_uri,
    source.artifactUri,
    source.artifact_uri,
  );
  if (artifactRef) return true;
  const schemaVersion = firstText(
    source.proofArtifactSchemaVersion,
    source.proof_artifact_schema_version,
    source.schemaVersion,
    source.schema_version,
  );
  return Boolean(firstText(source.proofId, source.proof_id) && schemaVersion);
}

function normalizedTargetProgressionEntryPhase(entry) {
  return normalizeTargetProgressionPhase(firstText(
    entry.phase,
    entry.phaseName,
    entry.phase_name,
    entry.targetProgressionPhase,
    entry.target_progression_phase,
  )).phase;
}

async function targetProgressionSmallOracleLedgerEvidence(entry, repoRoot, baseDir) {
  const computeArtifacts = compactObject(
    entry.compute_oracle_artifacts
    ?? entry.computeOracleArtifacts,
  );
  if (Object.keys(computeArtifacts).length > 0) {
    const compute = await realRocmComputeOracleFileIntegrityFacet({
      records: [{
        oracle_artifacts: {
          compute_oracle_artifacts: computeArtifacts,
        },
      }],
    }, repoRoot, baseDir);
    if (compute.accepted === true) {
      return {
        accepted: true,
        detail: 'raw compute oracle artifacts verified by matrix',
      };
    }
    return {
      accepted: false,
      detail: `compute oracle artifacts unverified: ${compute.failedGates.map((gate) => gate.code).join(',')}`,
    };
  }
  const visualArtifactsRaw = entry.visualEvidenceArtifacts ?? entry.visual_evidence_artifacts;
  const visualArtifacts = Array.isArray(visualArtifactsRaw)
    ? visualArtifactsRaw.filter((artifact) => typeof artifact === 'string' || isObject(artifact))
    : Object.keys(compactObject(visualArtifactsRaw)).length > 0
      ? [visualArtifactsRaw]
      : [];
  const visualRefs = compactStringList([
    ...(Array.isArray(entry.visualEvidenceRefs) ? entry.visualEvidenceRefs : []),
    ...(Array.isArray(entry.visual_evidence_refs) ? entry.visual_evidence_refs : []),
  ]);
  const primaryVisualArtifacts = visualArtifacts.filter((artifact) =>
    typeof artifact === 'string' || !visualEvidenceIsSupplementalOnly(artifact));
  const visualInputs = primaryVisualArtifacts.length > 0 ? primaryVisualArtifacts : visualRefs;
  if (visualArtifacts.length > 0 && primaryVisualArtifacts.length === 0) {
    return {
      accepted: false,
      detail: 'visual oracle artifacts are supplemental diagnostics only',
    };
  }
  if (visualInputs.length > 0) {
    const visual = await visualArtifactEvidence(visualInputs, repoRoot, baseDir, {}, {
      required: true,
      requireDeclaredHashes: true,
      requireDiff: true,
    });
    return {
      accepted: visual.accepted === true,
      detail: visual.accepted === true
        ? `visual oracle artifacts verified count=${visual.images?.length ?? 0}`
        : `visual oracle artifacts unverified: ${visual.failedGates?.join(',') || visual.reason || 'not_accepted'}`,
    };
  }
  return {
    accepted: false,
    detail: 'small-oracle ledger entry lacks raw compute or visual artifact evidence',
  };
}

async function targetProgressionLedgerPhaseResult(ledger, phase, { repoRoot, baseDir } = {}) {
  const normalizedPhase = normalizeTargetProgressionPhase(phase).phase;
  const entries = targetProgressionLedgerEntries(ledger)
    .filter((entry) => normalizedTargetProgressionEntryPhase(entry) === normalizedPhase);
  const failureDetails = [];
  for (const entry of entries) {
    const resultState = firstText(entry.resultState, entry.result_state);
    const structuredReference = hasTargetProgressionStructuredProofReference(entry);
    const statusPassedWithStructuredProof =
      targetProgressionEntryStatusPassed(entry) && structuredReference;
    if (normalizedPhase === 'small-oracle') {
      const oracleEvidence = await targetProgressionSmallOracleLedgerEvidence(
        entry,
        repoRoot,
        baseDir,
      );
      if (!structuredReference) {
        failureDetails.push('small-oracle structured proof reference missing');
      } else if (oracleEvidence.accepted !== true) {
        failureDetails.push(oracleEvidence.detail);
      } else if (
        resultState !== 'gpu-hmr-output-oracle-proven'
        && firstBool(entry.outputOracleProven, entry.output_oracle_proven) !== true
        && !statusPassedWithStructuredProof
      ) {
        failureDetails.push('small-oracle output-oracle success state missing');
      }
      if (
        structuredReference
        && oracleEvidence.accepted
        && (
          resultState === 'gpu-hmr-output-oracle-proven'
          || firstBool(entry.outputOracleProven, entry.output_oracle_proven) === true
          || statusPassedWithStructuredProof
        )
      ) {
        return {
          passed: true,
          detail: `small-oracle proof=${firstText(entry.proofId, entry.proof_id, entry.proofArtifactPath, entry.proof_artifact_path) ?? resultState ?? 'observed'}; ${oracleEvidence.detail}`,
        };
      }
    } else if (normalizedPhase === 'partial-reload') {
      const partialAndFission =
        firstBool(entry.partialReloadProven, entry.partial_reload_proven) === true
        && firstBool(entry.fissionProven, entry.fission_proven) === true;
      if (structuredReference && partialAndFission) {
        return {
          passed: true,
          detail: `partial-reload proof=${firstText(entry.proofId, entry.proof_id, entry.proofArtifactPath, entry.proof_artifact_path) ?? resultState ?? 'observed'}`,
        };
      }
    } else if (normalizedPhase === 'original-host-path') {
      const originalHostPath =
        firstBool(
          entry.originalHostPathProven,
          entry.original_host_path_proven,
          entry.attachmentProven,
          entry.attachment_proven,
        ) === true
        && firstBool(entry.hostPreservationProven, entry.host_preservation_proven) === true
        && firstBool(entry.dispatchSafeProven, entry.dispatch_safe_proven) === true;
      if (structuredReference && originalHostPath) {
        return {
          passed: true,
          detail: `original-host-path proof=${firstText(entry.proofId, entry.proof_id, entry.proofArtifactPath, entry.proof_artifact_path) ?? resultState ?? 'observed'}`,
        };
      }
    }
  }
  return {
    passed: false,
    detail: failureDetails.length > 0
      ? `prior phase ${normalizedPhase ?? phase} proof rejected: ${compactStringList(failureDetails).join('; ')}`
      : `prior phase ${normalizedPhase ?? phase} proof missing from target progression ledger`,
  };
}

function proofHasResultState(proof, state) {
  const source = compactObject(proof);
  return firstText(source.resultState, source.result_state) === state;
}

function partialArtifactReplacementProofObserved(sourceProofs = [], fissionProof = {}) {
  const proofs = Array.isArray(sourceProofs) ? sourceProofs : [];
  if (proofs.some((proof) =>
    proof?.partialArtifactReplacement === true
    || proof?.partial_artifact_replacement === true
    || proof?.partialModule === true
    || proof?.partial_module === true
    || /(^|[-_])partial($|[-_])/i.test(String(proof?.label ?? proof?.resultLabel ?? ''))
    || /partial|source[_-]?include|kernel[_-]?region/i.test(String(
      proof?.selectedArtifactKind
      ?? proof?.selected_artifact_kind
      ?? proof?.requestedArtifactKind
      ?? proof?.requested_artifact_kind
      ?? proof?.artifactKind
      ?? proof?.artifact_kind
      ?? '',
    ))
  )) {
    return true;
  }
  const selectedIslandContracts = Array.isArray(fissionProof?.selectedIslandContracts)
    ? fissionProof.selectedIslandContracts
    : Array.isArray(fissionProof?.selected_island_contracts)
      ? fissionProof.selected_island_contracts
      : [];
  return selectedIslandContracts.some((contract) =>
    /partial|source[_-]?include|kernel[_-]?region/i.test(String(contract?.artifactKind ?? contract?.artifact_kind ?? ''))
    || String(contract?.replacementScope ?? contract?.replacement_scope ?? '').trim().toLowerCase() === 'partial'
  );
}

function targetProgressionFullRuntimeGateAccepted({
  fullRuntimeProven,
  runtimeProofArtifactGate,
  ledger,
} = {}) {
  return fullRuntimeProven === true
    && runtimeProofArtifactGate?.accepted === true
    && ledger?.present === true
    && ledger?.source === 'recomputed_ledger'
    && ledger?.gpuHmrSuccess === true
    && Array.isArray(ledger?.failedInvariants)
    && ledger.failedInvariants.length === 0;
}

function targetProgressionOutputOracleDetail(outputOracleFacet = {}) {
  if (outputOracleFacet.accepted === true) {
    return `${outputOracleFacet.kind ?? 'output_oracle'} accepted by matrix`;
  }
  return (outputOracleFacet.failedGates ?? [])
    .map((gate) => gate.code)
    .filter(Boolean)
    .join(',') || 'output oracle not accepted by matrix';
}

async function recomputeTargetProgressionGateRows({
  targetProgression,
  targetName,
  targetProgressionLedger = {},
  sourceProofs = [],
  fissionProof = {},
  dispatchProof = {},
  outputOracleFacet = {},
  hostPreservationProof = {},
  originalHostPathProof = {},
  fullRuntimeProven = false,
  runtimeProofArtifactGate = {},
  ledger = {},
  repoRoot,
  baseDir,
} = {}) {
  const progression = normalizeTargetProgressionMetadata(targetProgression, { targetName });
  const rows = [];
  if (!progression.phase) {
    rows.push({
      name: 'target progression phase',
      status: progression.required ? 'fail' : 'skip',
      detail: progression.required
        ? 'target progression phase is required but was not declared'
        : 'target progression phase not declared',
    });
    return rows;
  }
  if (!progression.recognized) {
    return [{
      name: 'target progression phase',
      status: 'fail',
      detail: `unknown phase=${progression.phaseRaw}`,
    }];
  }
  rows.push({
    name: 'target progression phase',
    status: 'pass',
    detail: `phase=${progression.phase} target=${progression.targetName ?? 'unspecified'} final_target=${progression.finalAcceptanceTarget ?? 'unspecified'}`,
  });
  if (progression.nonFinalTargetRequired) {
    rows.push({
      name: 'target progression non-final target',
      status: progression.targetMatchesFinalAcceptance ? 'fail' : 'pass',
      detail: progression.targetMatchesFinalAcceptance
        ? `phase=${progression.phase} cannot use final_target=${progression.finalAcceptanceTarget}`
        : `phase=${progression.phase} target=${progression.targetName ?? 'unspecified'} final_target=${progression.finalAcceptanceTarget}`,
    });
  }
  if (progression.phase === 'final-acceptance' && progression.finalAcceptanceTargetDeclared) {
    rows.push({
      name: 'target progression final target',
      status: progression.targetMatchesFinalAcceptance ? 'pass' : 'fail',
      detail: progression.targetMatchesFinalAcceptance
        ? `target=${progression.targetName} matches final_target=${progression.finalAcceptanceTarget}`
        : `target=${progression.targetName ?? 'unspecified'} does not match final_target=${progression.finalAcceptanceTarget}`,
    });
  }
  if (progression.phase === 'small-oracle') {
    rows.push({
      name: 'target progression output oracle',
      status: outputOracleFacet.accepted === true ? 'pass' : 'fail',
      detail: targetProgressionOutputOracleDetail(outputOracleFacet),
    });
  }
  if (progression.phase === 'partial-reload') {
    const partialObserved = partialArtifactReplacementProofObserved(sourceProofs, fissionProof);
    rows.push({
      name: 'target progression partial reload',
      status: partialObserved ? 'pass' : 'fail',
      detail: partialObserved
        ? 'source/include-backed partial replacement observed'
        : 'source/include-backed partial replacement not observed',
    });
    rows.push({
      name: 'target progression fission proof',
      status: fissionProof?.fissionProven === true || fissionProof?.fission_proven === true ? 'pass' : 'fail',
      detail: fissionProof?.fissionProven === true || fissionProof?.fission_proven === true
        ? 'fission verifier proven'
        : 'fission verifier not proven',
    });
  }
  if (progression.phase === 'original-host-path') {
    rows.push({
      name: 'target progression dispatch proof',
      status: proofHasResultState(dispatchProof, 'gpu-hmr-dispatch-safe-proven') ? 'pass' : 'fail',
      detail: proofHasResultState(dispatchProof, 'gpu-hmr-dispatch-safe-proven')
        ? 'gpu-hmr-dispatch-safe-proven'
        : 'dispatch proof not proven',
    });
    rows.push({
      name: 'target progression original host path',
      status: originalHostPathProof?.attachmentProven === true
        || originalHostPathProof?.attachment_proven === true
        ? 'pass'
        : 'fail',
      detail: originalHostPathProof?.attachmentProven === true
        || originalHostPathProof?.attachment_proven === true
        ? 'original host path attachment proven'
        : 'original host path attachment not proven',
    });
    rows.push({
      name: 'target progression host preservation',
      status: proofHasResultState(hostPreservationProof, 'gpu-hmr-host-preservation-proven')
        ? 'pass'
        : 'fail',
      detail: proofHasResultState(hostPreservationProof, 'gpu-hmr-host-preservation-proven')
        ? 'gpu-hmr-host-preservation-proven'
        : 'host preservation proof not proven',
    });
  }
  if (progression.phase === 'final-acceptance') {
    if (progression.required) {
      for (const phase of FINAL_ACCEPTANCE_PRIOR_TARGET_PROGRESSION_PHASES) {
        const ledgerPhase = await targetProgressionLedgerPhaseResult(
          targetProgressionLedger,
          phase,
          { repoRoot, baseDir },
        );
        rows.push({
          name: `target progression prior ${phase}`,
          status: ledgerPhase.passed ? 'pass' : 'fail',
          detail: ledgerPhase.detail,
        });
      }
    }
    const fullRuntimeAccepted = targetProgressionFullRuntimeGateAccepted({
      fullRuntimeProven,
      runtimeProofArtifactGate,
      ledger,
    });
    rows.push({
      name: 'target progression full runtime',
      status: fullRuntimeAccepted ? 'pass' : 'fail',
      detail: fullRuntimeAccepted
        ? 'full runtime proof accepted by matrix'
        : 'full runtime proof not accepted by matrix',
    });
    const outputRowName = outputOracleFacet.kind === 'visual_oracle'
      ? 'target progression visual evidence'
      : 'target progression compute oracle artifacts';
    rows.push({
      name: outputRowName,
      status: outputOracleFacet.accepted === true ? 'pass' : 'fail',
      detail: targetProgressionOutputOracleDetail(outputOracleFacet),
    });
  }
  return rows;
}

function targetProgressionGateStatusRank(status) {
  if (status === 'fail') return 3;
  if (status === 'warn') return 2;
  if (status === 'pass') return 1;
  if (status === 'skip') return 0;
  return -1;
}

function mergeTargetProgressionGateRows(reportedRows = [], derivedRows = []) {
  const merged = [];
  const byName = new Map();
  for (const row of [
    ...(Array.isArray(derivedRows) ? derivedRows : []),
    ...(Array.isArray(reportedRows) ? reportedRows : []),
  ]) {
    if (!isObject(row)) continue;
    const name = firstText(row.name) ?? `target progression unnamed ${merged.length + 1}`;
    const normalized = { ...row, name };
    const existingIndex = byName.get(name);
    if (existingIndex === undefined) {
      byName.set(name, merged.length);
      merged.push(normalized);
      continue;
    }
    const existing = merged[existingIndex];
    if (
      targetProgressionGateStatusRank(normalized.status)
      > targetProgressionGateStatusRank(existing.status)
    ) {
      merged[existingIndex] = normalized;
    }
  }
  return merged;
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
  const sourceAdaptation = sourceAdaptationProofFacet(
    json,
    summary,
    runtimeProofArtifact,
    proofLedger,
    proofLedger.records?.[0],
    ledger.record,
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
  const upstreamLifecycleFailure = compactObject(
    json.upstream_lifecycle_failure
    ?? json.upstreamLifecycleFailure
    ?? summary.upstream_lifecycle_failure
    ?? summary.upstreamLifecycleFailure
    ?? runtimeProofArtifact.upstream_lifecycle_failure
    ?? runtimeProofArtifact.upstreamLifecycleFailure,
  );
  const workerRepoTransferFailure = compactObject(
    json.worker_repo_transfer_failure
    ?? json.workerRepoTransferFailure
    ?? summary.worker_repo_transfer_failure
    ?? summary.workerRepoTransferFailure
    ?? runtimeProofArtifact.worker_repo_transfer_failure
    ?? runtimeProofArtifact.workerRepoTransferFailure,
  );
  const outputOracleResolution = compactObject(
    json.output_oracle_resolution
    ?? json.outputOracleResolution
    ?? summary.output_oracle_resolution
    ?? summary.outputOracleResolution,
  );
  const outputOracleContract = compactObject(
    json.output_oracle_contract
    ?? json.outputOracleContract
    ?? summary.output_oracle_contract
    ?? summary.outputOracleContract
    ?? runtimeProofArtifact.output_oracle_contract
    ?? runtimeProofArtifact.outputOracleContract,
  );
  const outputOracleRuntimeProfile = compactObject(
    json.output_oracle_runtime_profile
    ?? json.outputOracleRuntimeProfile
    ?? summary.output_oracle_runtime_profile
    ?? summary.outputOracleRuntimeProfile
    ?? runtimeProofArtifact.output_oracle_runtime_profile
    ?? runtimeProofArtifact.outputOracleRuntimeProfile,
  );
  const targetProgression = compactObject(
    json.target_progression
    ?? json.targetProgression
    ?? summary.target_progression
    ?? summary.targetProgression,
  );
  const targetProgressionLedger = compactObject(
    json.target_progression_ledger
    ?? json.targetProgressionLedger
    ?? summary.target_progression_ledger
    ?? summary.targetProgressionLedger,
  );
  const outputOracleResolutionGate = realRocmOutputOracleResolutionGate(outputOracleResolution, {
    required: true,
  });
  const realRocmRuntimeChain = realRocmRuntimeChainFacet({ ledger, proofLedger });
  const reportedTargetProgressionGates = compactObjectList(
    json.target_progression_gates
    ?? json.targetProgressionGates
    ?? summary.target_progression_gates
    ?? summary.targetProgressionGates,
  );
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
  const serializedRealRocmProfileProofObligations = compactObject(
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
  const realRocmSourceDeltaExecution = realRocmSourceDeltaExecutionFacet(compactObject(
    json.real_rocm_source_delta_execution
    ?? json.realRocmSourceDeltaExecution
    ?? json.source_delta_execution
    ?? json.sourceDeltaExecution
    ?? summary.real_rocm_source_delta_execution
    ?? summary.realRocmSourceDeltaExecution
    ?? summary.source_delta_execution
    ?? summary.sourceDeltaExecution
    ?? runtimeProofArtifact.real_rocm_source_delta_execution
    ?? runtimeProofArtifact.realRocmSourceDeltaExecution
    ?? runtimeProofArtifact.source_delta_execution
    ?? runtimeProofArtifact.sourceDeltaExecution,
  ));
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
  const realRocmSameProcessRuntimeOracle = compactObject(
    json.real_rocm_same_process_runtime_oracle
    ?? json.realRocmSameProcessRuntimeOracle
    ?? json.same_process_runtime_oracle
    ?? json.sameProcessRuntimeOracle
    ?? summary.real_rocm_same_process_runtime_oracle
    ?? summary.realRocmSameProcessRuntimeOracle
    ?? summary.same_process_runtime_oracle
    ?? summary.sameProcessRuntimeOracle
    ?? runtimeProofArtifact.real_rocm_same_process_runtime_oracle
    ?? runtimeProofArtifact.realRocmSameProcessRuntimeOracle
    ?? runtimeProofArtifact.same_process_runtime_oracle
    ?? runtimeProofArtifact.sameProcessRuntimeOracle,
  );
  const realRocmProfileProofObligations = realRocmProfileProofObligationsMatrixFacet({
    profile,
    targetProgression,
    outputOracleResolution,
    outputOracleContract,
    outputOracleRuntimeProfile,
    appHookContract: realRocmAppHookContract,
    sourceDeltaExecution: realRocmSourceDeltaExecution,
    serialized: serializedRealRocmProfileProofObligations,
    fullRuntimeProofRequired: realRocmRequiredFullRuntimeProof(json),
  });
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
  const realRocmRuntimeStageObligations = compactObject(
    json.real_rocm_runtime_stage_obligations
    ?? json.realRocmRuntimeStageObligations
    ?? json.runtime_stage_obligations
    ?? json.runtimeStageObligations
    ?? summary.real_rocm_runtime_stage_obligations
    ?? summary.realRocmRuntimeStageObligations
    ?? summary.runtime_stage_obligations
    ?? summary.runtimeStageObligations
    ?? runtimeProofArtifact.real_rocm_runtime_stage_obligations
    ?? runtimeProofArtifact.realRocmRuntimeStageObligations
    ?? runtimeProofArtifact.runtime_stage_obligations
    ?? runtimeProofArtifact.runtimeStageObligations,
  );
  const realRocmAppHookMaterialization = compactObject(
    json.real_rocm_app_hook_materialization
    ?? json.realRocmAppHookMaterialization
    ?? json.app_hook_materialization
    ?? json.appHookMaterialization
    ?? summary.real_rocm_app_hook_materialization
    ?? summary.realRocmAppHookMaterialization
    ?? summary.app_hook_materialization
    ?? summary.appHookMaterialization
    ?? runtimeProofArtifact.real_rocm_app_hook_materialization
    ?? runtimeProofArtifact.realRocmAppHookMaterialization
    ?? runtimeProofArtifact.app_hook_materialization
    ?? runtimeProofArtifact.appHookMaterialization,
  );
  const topLevelValidationBlockers = compactObjectList([
    ...(Array.isArray(json.validation_blockers) ? json.validation_blockers : []),
    ...(Array.isArray(json.validationBlockers) ? json.validationBlockers : []),
  ]);
  const realRocmProofScheduling = realRocmProofSchedulingGate(compactObject(
    json.real_rocm_proof_scheduling
    ?? json.realRocmProofScheduling
    ?? json.proof_scheduling
    ?? json.proofScheduling
    ?? json.timeout_intelligence_failure
    ?? json.timeoutIntelligenceFailure
    ?? summary.real_rocm_proof_scheduling
    ?? summary.realRocmProofScheduling
    ?? summary.proof_scheduling
    ?? summary.proofScheduling
    ?? summary.timeout_intelligence_failure
    ?? summary.timeoutIntelligenceFailure
    ?? runtimeProofArtifact.real_rocm_proof_scheduling
    ?? runtimeProofArtifact.realRocmProofScheduling
    ?? runtimeProofArtifact.proof_scheduling
    ?? runtimeProofArtifact.proofScheduling
    ?? runtimeProofArtifact.timeout_intelligence_failure
    ?? runtimeProofArtifact.timeoutIntelligenceFailure
    ?? (
      topLevelValidationBlockers.length > 0
        ? {
          schemaVersion: REAL_ROCM_PROOF_SCHEDULING_SCHEMA_VERSION,
          proofAuthority: 'proof_scheduling_evidence_only_not_gpu_hmr_success',
          acceptedAsRefusalEvidence: true,
          acceptedForGpuHmr: false,
          gpuHmrSuccess: false,
          canSatisfyRuntimeProof: false,
          validationBlockers: topLevelValidationBlockers,
        }
        : null
    ),
  ));
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
  const realRocmSourceDeltaExecutionGaps = compactStringList([
    ...(Array.isArray(realRocmSourceDeltaExecution.failedGates) ? realRocmSourceDeltaExecution.failedGates : []),
    ...(Array.isArray(realRocmSourceDeltaExecution.failed_gates) ? realRocmSourceDeltaExecution.failed_gates : []),
  ]);
  const realRocmSourceDeltaExecutionRelevant =
    realRocmProfileProofObligations.requiresRunModes === true
    || realRocmProfileProofObligations.requires_run_modes === true
    || realRocmProfileProofObligations.requiresNegativeEdit === true
    || realRocmProfileProofObligations.requires_negative_edit === true
    || realRocmSourceDeltaExecution.present === true;
  const realRocmSourceDeltaExecutionReportGaps = realRocmSourceDeltaExecutionRelevant
    ? realRocmSourceDeltaExecutionGaps
    : [];
  const realRocmAppHookContractGaps = compactStringList([
    ...(Array.isArray(realRocmAppHookContract.blockingGaps) ? realRocmAppHookContract.blockingGaps : []),
    ...(Array.isArray(realRocmAppHookContract.blocking_gaps) ? realRocmAppHookContract.blocking_gaps : []),
  ]);
  const realRocmSameProcessRuntimeOracleGaps = compactStringList([
    ...(Array.isArray(realRocmSameProcessRuntimeOracle.blockingGaps)
      ? realRocmSameProcessRuntimeOracle.blockingGaps
      : []),
    ...(Array.isArray(realRocmSameProcessRuntimeOracle.blocking_gaps)
      ? realRocmSameProcessRuntimeOracle.blocking_gaps
      : []),
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
  const realRocmProofSchedulingGaps = compactStringList([
    ...(Array.isArray(realRocmProofScheduling.blockingGaps)
      ? realRocmProofScheduling.blockingGaps
      : []),
    ...(Array.isArray(realRocmProofScheduling.blocking_gaps)
      ? realRocmProofScheduling.blocking_gaps
      : []),
    ...(Array.isArray(realRocmProofScheduling.failedGates)
      ? realRocmProofScheduling.failedGates
      : []),
    ...(Array.isArray(realRocmProofScheduling.failed_gates)
      ? realRocmProofScheduling.failed_gates
      : []),
  ]);
  const realRocmAppHookMaterializationGaps = compactStringList([
    ...(Array.isArray(realRocmAppHookMaterialization.blockingGaps)
      ? realRocmAppHookMaterialization.blockingGaps
      : []),
    ...(Array.isArray(realRocmAppHookMaterialization.blocking_gaps)
      ? realRocmAppHookMaterialization.blocking_gaps
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
  const realRocmSameProcessRuntimeOracleReason =
    Object.keys(realRocmSameProcessRuntimeOracle).length > 0
      ? firstText(realRocmSameProcessRuntimeOracle.status, realRocmSameProcessRuntimeOracle.reason)
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
  const realRocmProofSchedulingReason =
    realRocmProofScheduling.present === true
      ? firstText(realRocmProofScheduling.status, realRocmProofScheduling.reason)
      : null;
  const realRocmAppHookMaterializationReason =
    Object.keys(realRocmAppHookMaterialization).length > 0
      ? firstText(realRocmAppHookMaterialization.status, realRocmAppHookMaterialization.reason)
      : null;
  const hmrWaitDetail = realRocmCheckDetailJson(checks, 'real_repo_user_source_delta_hmr')
    ?? realRocmCheckDetailJson(checks, 'first_real_repo_ai_split_compile');
  const hmrProofValidation = compactObject(hmrWaitDetail?.gpu_proof_validation);
  const profileId = firstText(profile.id, json.profileId, json.profile_id, json.slug);
  const targetId = firstText(profileId, json.slug, json.target_name, json.targetName);
  const targetProgressionTargetName = firstText(
    targetProgression.targetName,
    targetProgression.target_name,
    json.target_name,
    json.targetName,
    profile.target?.targetName,
    profile.target?.target_name,
  );
  const normalizedTargetProgression = normalizeTargetProgressionMetadata(targetProgression, {
    targetName: targetProgressionTargetName,
  });
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
  const visualInputs = [
    ...(Array.isArray(json.visual_artifact_paths) ? json.visual_artifact_paths : []),
    ...(Array.isArray(json.visualArtifactPaths) ? json.visualArtifactPaths : []),
    ...(Array.isArray(summary.visual_artifact_paths) ? summary.visual_artifact_paths : []),
    ...(Array.isArray(summary.visualArtifactPaths) ? summary.visualArtifactPaths : []),
    ...visualEvidenceInputsFromValue(json.visualEvidenceArtifacts ?? json.visual_evidence_artifacts),
  ];
  const visual = await visualArtifactEvidence(
    visualInputs,
    context.repoRoot,
    path.dirname(filePath),
    compactObject(json.visual_evidence_quality ?? json.visualEvidenceQuality),
    visualInputs.length > 0 ? runtimeVisualOracleEvidenceRequirements() : false,
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
  const sameProcessRuntimeOracleGate = realRocmSameProcessRuntimeOracleGate({
    realRocmSameProcessRuntimeOracle,
    realRocmAppHookContractGate: appHookContractGate,
    runtimeProofArtifactGate,
    ledger,
    proofLedger,
    realRocmRuntimeChain,
    outputOracleFacet,
    realRocmFirewall,
  });
  const sameProcessRuntimeOracleAccepted = sameProcessRuntimeOracleGate.accepted === true;
  const runtimeCapabilityPreflightPresent = realRocmRuntimeCapabilityPreflight.present === true;
  const runtimeCapabilityPreflightAccepted =
    runtimeCapabilityPreflightPresent
    && realRocmRuntimeCapabilityPreflight.accepted === true;
  const sidecarRuntimeConsistencyGate = realRocmSidecarRuntimeConsistencyGate(
    realRocmSidecarRuntimeConsistency,
  );
  const sidecarRuntimeConsistencyAccepted = sidecarRuntimeConsistencyGate.accepted === true;
  const runtimeStageObligationsGate = realRocmRuntimeStageObligationsGate(
    realRocmRuntimeStageObligations,
  );
  const runtimeStageObligationsAccepted =
    runtimeStageObligationsGate.present !== true
    || runtimeStageObligationsGate.accepted === true;
  const appHookMaterializationGate = realRocmAppHookMaterializationGate(
    realRocmAppHookMaterialization,
  );
  const appHookMaterializationAccepted =
    appHookMaterializationGate.present !== true
    || appHookMaterializationGate.accepted === true;
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
  const recomputedTargetProgressionGates = await recomputeTargetProgressionGateRows({
    targetProgression,
    targetName: targetProgressionTargetName,
    targetProgressionLedger,
    sourceProofs: compactObjectList(
      json.source_proofs
      ?? json.sourceProofs
      ?? summary.source_proofs
      ?? summary.sourceProofs,
    ),
    fissionProof: compactObject(
      json.fission_proof
      ?? json.fissionProof
      ?? summary.fission_proof
      ?? summary.fissionProof,
    ),
    dispatchProof: compactObject(
      json.dispatch_proof
      ?? json.dispatchProof
      ?? summary.dispatch_proof
      ?? summary.dispatchProof,
    ),
    outputOracleFacet,
    hostPreservationProof: compactObject(
      json.host_preservation_proof
      ?? json.hostPreservationProof
      ?? summary.host_preservation_proof
      ?? summary.hostPreservationProof,
    ),
    originalHostPathProof: compactObject(
      json.original_host_path_proof
      ?? json.originalHostPathProof
      ?? summary.original_host_path_proof
      ?? summary.originalHostPathProof,
    ),
    fullRuntimeProven,
    runtimeProofArtifactGate,
    ledger,
    repoRoot: context.repoRoot,
    baseDir: path.dirname(filePath),
  });
  const targetProgressionGates = mergeTargetProgressionGateRows(
    reportedTargetProgressionGates,
    recomputedTargetProgressionGates,
  );
  const targetProgressionGateFailures = targetProgressionGates
    .filter((gate) => text(gate.status)?.toLowerCase() === 'fail');
  const finalTargetProgressionAllowsGpuHmrAcceptance =
    !normalizedTargetProgression.phase
    || normalizedTargetProgression.phase === 'final-acceptance';
  const accepted =
    finalTargetProgressionAllowsGpuHmrAcceptance
    && gpuHmrSuccess === true
    && fullRuntimeProven === true
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && runtimeProofArtifactGate.accepted === true
    && outputOrVisualOracleAccepted === true
    && outputOracleResolutionGate.accepted === true
    && realRocmRuntimeChain.accepted === true
    && appHookContractAccepted === true
    && sameProcessRuntimeOracleAccepted === true
    && runtimeCapabilityPreflightAccepted === true
    && sidecarRuntimeConsistencyAccepted === true
    && runtimeStageObligationsAccepted === true
    && appHookMaterializationAccepted === true
    && profileProofObligationsAccepted === true
    && targetProgressionGateFailures.length === 0
    && realRocmFirewall.accepted === true
    && sourceAdaptation.acceptedForNoShimHmr === true;
  const targetProgressionEvidence =
    !accepted
    && normalizedTargetProgression.nonFinalPhase === true
    && targetProgressionGateFailures.length === 0;
  const strictRuntimeGateFailed =
    strictGates.accepted === false
    || strictGateFailures.length > 0
    || runtimeProofArtifactGate.present === false
    || runtimeProofArtifactGate.accepted === false;
  const proofStateMissing =
    hmrProofValidation.reason === 'proof_state_missing'
    || hmrProofValidation.satisfied === false
    || hmrWaitDetail?.wait_hmr_status === 'timeout';
  const proofSchedulingRefusalAccepted =
    realRocmProofScheduling.present === true
    && realRocmProofScheduling.accepted === true
    && realRocmProofScheduling.acceptedAsRefusalEvidence === true;
  const refusalProven =
    !accepted
    && realRocmRequiredFullRuntimeProof(json)
    && gpuHmrSuccess !== true
    && fullRuntimeProven !== true
    && (strictRuntimeGateFailed || proofStateMissing || proofSchedulingRefusalAccepted);
  const attemptCompleteness = realRocmAttemptCompletenessFacet({
    accepted,
    upstreamLifecycleFailure,
    workerRepoTransferFailure,
    proofScheduling: realRocmProofScheduling,
    runtimeProofArtifact: runtimeProofArtifactGate,
    strictGateFailures,
    ledger,
  });
  const matrixOutcome = accepted
    ? 'full_runtime_gpu_hmr'
    : targetProgressionEvidence
      ? 'target_progression_evidence'
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
    evidenceKind: accepted
      ? 'large_repo_output_oracle'
      : targetProgressionEvidence
        ? 'target_progression_evidence'
        : 'large_repo_runtime_refusal',
    matrixOutcome,
    acceptanceClass: accepted
      ? 'full_runtime_gpu_hmr'
      : targetProgressionEvidence
        ? 'large_real_rocm_target_progression_evidence'
      : refusalProven
        ? 'large_real_rocm_repo_refusal'
        : 'large_real_rocm_repo_unproven',
    acceptedForGpuHmr: accepted,
    gpuHmrSuccess: accepted,
    refusalProven,
    proofChainAccepted: accepted || targetProgressionEvidence || refusalProven,
    proofChain: accepted
      ? 'real_rocm_full_runtime_ledger_oracle_chain'
      : targetProgressionEvidence
        ? 'real_rocm_target_progression_evidence_chain'
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
    acceptanceContract: compactObject(
      json.acceptanceContract
      ?? json.acceptance_contract
      ?? runtimeProofArtifact.acceptanceContract
      ?? runtimeProofArtifact.acceptance_contract,
    ),
    acceptance_contract: compactObject(
      json.acceptanceContract
      ?? json.acceptance_contract
      ?? runtimeProofArtifact.acceptanceContract
      ?? runtimeProofArtifact.acceptance_contract,
    ),
    artifactAfterHash: firstText(
      json.artifactAfterHash,
      json.artifact_after_hash,
      ledger.record?.artifactAfterHash,
      ledger.record?.artifact_after_hash,
    ),
    artifact_after_hash: firstText(
      json.artifactAfterHash,
      json.artifact_after_hash,
      ledger.record?.artifactAfterHash,
      ledger.record?.artifact_after_hash,
    ),
    artifactBeforeHash: firstText(
      json.artifactBeforeHash,
      json.artifact_before_hash,
      ledger.record?.artifactBeforeHash,
      ledger.record?.artifact_before_hash,
    ),
    artifact_before_hash: firstText(
      json.artifactBeforeHash,
      json.artifact_before_hash,
      ledger.record?.artifactBeforeHash,
      ledger.record?.artifact_before_hash,
    ),
    runtimeProofArtifact: runtimeProofArtifactGate,
    runtime_proof_artifact: runtimeProofArtifactGate,
    sourceAdaptation,
    source_adaptation: sourceAdaptation,
    sourceAdaptedProfile: sourceAdaptation.sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptation.sourceAdaptedProfile,
    visual,
    outputOracleFacet,
    output_oracle_facet: outputOracleFacet,
    outputOracleResolutionGate,
    output_oracle_resolution_gate: outputOracleResolutionGate,
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
    upstreamLifecycleFailure,
    upstream_lifecycle_failure: upstreamLifecycleFailure,
    workerRepoTransferFailure,
    worker_repo_transfer_failure: workerRepoTransferFailure,
    attemptCompleteness,
    attempt_completeness: attemptCompleteness,
    outputOracleResolution,
    realRocmRuntimeChain,
    real_rocm_runtime_chain: realRocmRuntimeChain,
    targetProgression,
    normalizedTargetProgression,
    normalized_target_progression: normalizedTargetProgression,
    targetProgressionEvidence,
    target_progression_evidence: targetProgressionEvidence,
    realRocmProfileProofObligations,
    real_rocm_profile_proof_obligations: realRocmProfileProofObligations,
    realRocmSourceDeltaExecution,
    real_rocm_source_delta_execution: realRocmSourceDeltaExecution,
    targetProgressionGates,
    nativeRocmLaunchBoundary,
    native_rocm_launch_boundary: nativeRocmLaunchBoundary,
    realRocmRuntimeEligibility,
    real_rocm_runtime_eligibility: realRocmRuntimeEligibility,
    realRocmAppHookContract,
    real_rocm_app_hook_contract: realRocmAppHookContract,
    realRocmAppHookContractGate: appHookContractGate,
    real_rocm_app_hook_contract_gate: appHookContractGate,
    realRocmSameProcessRuntimeOracle,
    real_rocm_same_process_runtime_oracle: realRocmSameProcessRuntimeOracle,
    sameProcessRuntimeOracle: realRocmSameProcessRuntimeOracle,
    same_process_runtime_oracle: realRocmSameProcessRuntimeOracle,
    realRocmSameProcessRuntimeOracleGate: sameProcessRuntimeOracleGate,
    real_rocm_same_process_runtime_oracle_gate: sameProcessRuntimeOracleGate,
    realRocmDeviceSidecarContract,
    real_rocm_device_sidecar_contract: realRocmDeviceSidecarContract,
    realRocmSidecarRuntimeConsistency,
    real_rocm_sidecar_runtime_consistency: realRocmSidecarRuntimeConsistency,
    realRocmSidecarRuntimeConsistencyGate: sidecarRuntimeConsistencyGate,
    real_rocm_sidecar_runtime_consistency_gate: sidecarRuntimeConsistencyGate,
    realRocmCompileBridge,
    real_rocm_compile_bridge: realRocmCompileBridge,
    realRocmRuntimeStageObligations,
    real_rocm_runtime_stage_obligations: realRocmRuntimeStageObligations,
    runtimeStageObligations: realRocmRuntimeStageObligations,
    runtime_stage_obligations: realRocmRuntimeStageObligations,
    realRocmRuntimeStageObligationsGate: runtimeStageObligationsGate,
    real_rocm_runtime_stage_obligations_gate: runtimeStageObligationsGate,
    realRocmAppHookMaterialization,
    real_rocm_app_hook_materialization: realRocmAppHookMaterialization,
    appHookMaterialization: realRocmAppHookMaterialization,
    app_hook_materialization: realRocmAppHookMaterialization,
    realRocmAppHookMaterializationGate: appHookMaterializationGate,
    real_rocm_app_hook_materialization_gate: appHookMaterializationGate,
    realRocmProofScheduling,
    real_rocm_proof_scheduling: realRocmProofScheduling,
    proofScheduling: realRocmProofScheduling,
    proof_scheduling: realRocmProofScheduling,
    timeoutIntelligenceFailure: realRocmProofScheduling,
    timeout_intelligence_failure: realRocmProofScheduling,
    realRocmRuntimeCapabilityPreflight,
    real_rocm_runtime_capability_preflight: realRocmRuntimeCapabilityPreflight,
    timings: compactObject(runMode.present ? json.timingMetrics ?? json.timing_metrics ?? summary.timings?.timingMetrics : {}),
    reasons: compactStringList([
      ...strictGateFailures,
      ...runtimeProofArtifactGate.failedGates.map((failure) => failure.code),
      ...targetProgressionGateFailures.map((gate) => `target_progression_gate_failed:${text(gate.name) ?? 'unnamed'}`),
      ...outputOracleFacet.failedGates.map((failure) => failure.code),
      ...outputOracleResolutionGate.failedGates,
      nativeRocmBoundaryReason ? `native_rocm_launch_boundary:${nativeRocmBoundaryReason}` : null,
      ...nativeRocmBoundaryGaps.map((gap) => `native_rocm_launch_boundary:${gap}`),
      realRocmRuntimeEligibilityReason ? `real_rocm_runtime_eligibility:${realRocmRuntimeEligibilityReason}` : null,
      ...realRocmRuntimeEligibilityGaps.map((gap) => `real_rocm_runtime_eligibility:${gap}`),
      realRocmProfileProofObligationsReason ? `real_rocm_profile_proof_obligations:${realRocmProfileProofObligationsReason}` : null,
      ...realRocmProfileProofObligationsGaps.map((gap) => `real_rocm_profile_proof_obligations:${gap}`),
      ...realRocmSourceDeltaExecutionReportGaps.map((gap) => `real_rocm_source_delta_execution:${gap}`),
      realRocmAppHookContractReason ? `real_rocm_app_hook_contract:${realRocmAppHookContractReason}` : null,
      ...realRocmAppHookContractGaps.map((gap) => `real_rocm_app_hook_contract:${gap}`),
      ...appHookContractGate.failedGaps,
      realRocmSameProcessRuntimeOracleReason
        ? `real_rocm_same_process_runtime_oracle:${realRocmSameProcessRuntimeOracleReason}`
        : null,
      ...realRocmSameProcessRuntimeOracleGaps.map((gap) =>
        `real_rocm_same_process_runtime_oracle:${gap}`
      ),
      ...sameProcessRuntimeOracleGate.failedGates.map((gap) =>
        `real_rocm_same_process_runtime_oracle:${gap}`
      ),
      !accepted && realRocmDeviceSidecarContractReason
        ? `real_rocm_device_sidecar_contract:${realRocmDeviceSidecarContractReason}`
        : null,
      ...(!accepted ? realRocmDeviceSidecarContractGaps.map((gap) => `real_rocm_device_sidecar_contract:${gap}`) : []),
      !accepted && realRocmSidecarRuntimeConsistencyReason
        ? `real_rocm_sidecar_runtime_consistency:${realRocmSidecarRuntimeConsistencyReason}`
        : null,
      ...(!accepted ? realRocmSidecarRuntimeConsistencyGaps.map((gap) => `real_rocm_sidecar_runtime_consistency:${gap}`) : []),
      ...(!accepted ? sidecarRuntimeConsistencyGate.failedGates.map((gap) =>
        `real_rocm_sidecar_runtime_consistency:${gap}`
      ) : []),
      realRocmCompileBridgeReason ? `real_rocm_compile_bridge:${realRocmCompileBridgeReason}` : null,
      ...realRocmCompileBridgeGaps.map((gap) => `real_rocm_compile_bridge:${gap}`),
      ...runtimeStageObligationsGate.failedGates.map((gap) =>
        `real_rocm_runtime_stage_obligations:${gap}`
      ),
      realRocmAppHookMaterializationReason
        ? `real_rocm_app_hook_materialization:${realRocmAppHookMaterializationReason}`
        : null,
      ...realRocmAppHookMaterializationGaps.map((gap) =>
        `real_rocm_app_hook_materialization:${gap}`
      ),
      ...appHookMaterializationGate.failedGates.map((gap) =>
        `real_rocm_app_hook_materialization:${gap}`
      ),
      realRocmRuntimeCapabilityPreflightReason
        ? `real_rocm_runtime_capability_preflight:${realRocmRuntimeCapabilityPreflightReason}`
        : null,
      ...realRocmRuntimeCapabilityPreflightGaps.map((gap) =>
        `real_rocm_runtime_capability_preflight:${gap}`
      ),
      ...(Array.isArray(ledger.failedInvariants) ? ledger.failedInvariants.map((failure) => failure.code) : []),
      ...realRocmFirewall.failedGates.map((failure) => failure.code),
      sourceAdaptation.sourceAdaptedProfile ? 'source_adapted_profile_not_no_shim_gpu_hmr' : null,
      hmrProofValidation.reason,
      outputOrVisualOracleAccepted ? null : 'output_or_visual_oracle_proof_missing',
      outputOracleResolutionGate.accepted ? null : 'real_rocm_output_oracle_resolution_not_accepted',
      realRocmRuntimeChain.accepted ? null : 'real_rocm_runtime_chain_not_accepted',
      ...realRocmRuntimeChain.failedGates.map((failure) => failure.code),
      appHookContractAccepted ? null : 'real_rocm_app_hook_contract_required_not_proven',
      runtimeCapabilityPreflightAccepted ? null : 'real_rocm_runtime_capability_preflight_not_proven',
      sidecarRuntimeConsistencyAccepted ? null : 'real_rocm_sidecar_runtime_consistency_not_proven',
      ...sidecarRuntimeConsistencyGate.failedGates.map((failure) =>
        `real_rocm_sidecar_runtime_consistency:${failure}`
      ),
      runtimeStageObligationsAccepted ? null : 'real_rocm_runtime_stage_obligations_not_met',
      ...runtimeStageObligationsGate.failedGates.map((failure) =>
        `real_rocm_runtime_stage_obligations:${failure}`
      ),
      appHookMaterializationAccepted ? null : 'real_rocm_app_hook_materialization_not_accepted',
      ...appHookMaterializationGate.failedGates.map((failure) =>
        `real_rocm_app_hook_materialization:${failure}`
      ),
      realRocmProofSchedulingReason
        ? `real_rocm_proof_scheduling:${realRocmProofSchedulingReason}`
        : null,
      ...realRocmProofSchedulingGaps.map((gap) =>
        `real_rocm_proof_scheduling:${gap}`
      ),
      profileProofObligationsAccepted ? null : 'real_rocm_profile_proof_obligations_not_met',
      realRocmFirewall.accepted ? null : 'real_rocm_cpu_gpu_firewall_not_proven',
      ledger.present === true ? null : 'proof_ledger_record_missing',
      realRocmRequiredFullRuntimeProof(json) ? null : 'full_runtime_proof_not_required_by_artifact',
    ]),
    openGaps: accepted ? [] : compactStringList([
      runtimeProofArtifactGate.accepted === true ? null : 'strict_runtime_proof_artifact_required',
      ledger.gpuHmrSuccess === true ? null : 'proof_ledger_success_required',
      outputOrVisualOracleAccepted ? null : 'output_or_visual_oracle_proof_required',
      outputOracleResolutionGate.accepted ? null : 'real_rocm_output_oracle_resolution_required',
      ...outputOracleResolutionGate.failedGates,
      realRocmRuntimeChain.accepted ? null : 'real_rocm_runtime_chain_required',
      ...realRocmRuntimeChain.failedGates.map((failure) => failure.code),
      appHookContractAccepted ? null : 'real_rocm_app_hook_contract_required',
      ...appHookContractGate.failedGaps,
      sameProcessRuntimeOracleAccepted ? null : 'real_rocm_same_process_runtime_oracle_required',
      ...sameProcessRuntimeOracleGate.failedGates.map((gap) =>
        `real_rocm_same_process_runtime_oracle:${gap}`
      ),
      runtimeCapabilityPreflightAccepted
        ? null
        : runtimeCapabilityPreflightPresent
          ? 'real_rocm_runtime_capability_preflight_failed'
          : 'real_rocm_runtime_capability_preflight_required',
      sidecarRuntimeConsistencyAccepted ? null : 'real_rocm_sidecar_runtime_consistency_required',
      ...sidecarRuntimeConsistencyGate.failedGates.map((failure) =>
        `real_rocm_sidecar_runtime_consistency:${failure}`
      ),
      profileProofObligationsAccepted ? null : 'real_rocm_profile_proof_obligations_required',
      realRocmFirewall.accepted ? null : 'real_rocm_cpu_gpu_firewall_required',
      ...sourceAdaptation.failedGates.map((failure) => failure.code),
      proofStateMissing ? 'gpu_hmr_full_runtime_proof_state_missing' : null,
      targetProgressionGateFailures.length > 0 ? 'target_progression_gates_failed' : null,
      ...nativeRocmBoundaryGaps.map((gap) => `native_rocm_launch_boundary:${gap}`),
      ...realRocmRuntimeEligibilityGaps.map((gap) => `real_rocm_runtime_eligibility:${gap}`),
      ...realRocmProfileProofObligationsGaps.map((gap) => `real_rocm_profile_proof_obligations:${gap}`),
      ...realRocmSourceDeltaExecutionReportGaps.map((gap) => `real_rocm_source_delta_execution:${gap}`),
      ...realRocmAppHookContractGaps.map((gap) => `real_rocm_app_hook_contract:${gap}`),
      ...realRocmSameProcessRuntimeOracleGaps.map((gap) =>
        `real_rocm_same_process_runtime_oracle:${gap}`
      ),
      ...realRocmDeviceSidecarContractGaps.map((gap) => `real_rocm_device_sidecar_contract:${gap}`),
      ...realRocmSidecarRuntimeConsistencyGaps.map((gap) => `real_rocm_sidecar_runtime_consistency:${gap}`),
      ...realRocmCompileBridgeGaps.map((gap) => `real_rocm_compile_bridge:${gap}`),
      runtimeStageObligationsAccepted ? null : 'real_rocm_runtime_stage_obligations_required',
      ...runtimeStageObligationsGate.failedGates.map((failure) =>
        `real_rocm_runtime_stage_obligations:${failure}`
      ),
      appHookMaterializationAccepted ? null : 'real_rocm_app_hook_materialization_required',
      ...realRocmAppHookMaterializationGaps.map((gap) =>
        `real_rocm_app_hook_materialization:${gap}`
      ),
      ...appHookMaterializationGate.failedGates.map((failure) =>
        `real_rocm_app_hook_materialization:${failure}`
      ),
      ...realRocmProofSchedulingGaps.map((gap) =>
        `real_rocm_proof_scheduling:${gap}`
      ),
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
  const requiresSourceFirstIngestion = schema === 'synthi.gpu.hmr.agent_split_run_mode_proof.v1';
  const sourceFirstIngestion = sourceFirstIngestionFacet(json);
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
  const fixtureId = firstText(json.fixtureId, json.fixture_id);
  const validationProfileId = firstText(json.validationProfileId, json.validation_profile_id);
  const proofValidation = compactObject(json.gpuProofValidation ?? json.gpu_proof_validation ?? json.proofValidation);
  const ledgerValidation = compactObject(proofValidation.proofLedgerValidation);
  const runtimeValidation = compactObject(proofValidation.runtimeProofArtifactValidation);
  const runtimeProofArtifact = runtimeProofArtifactFromValue(json);
  const ledger = runModeLedgerFacet(json, runtimeProofArtifact);
  const runtimeProofArtifactGate = runtimeProofArtifactFacet(runtimeProofArtifact);
  const runtimeProbeInstrumentation = runtimeProbeInstrumentationDisclosureFacet(
    json.runtimeProbeInstrumentation,
    json.runtime_probe_instrumentation,
    runtimeProofArtifact.runtimeProbeInstrumentation,
    runtimeProofArtifact.runtime_probe_instrumentation,
    json.proofLedger?.records?.[0]?.runtimeProbeInstrumentation,
    json.proofLedger?.records?.[0]?.runtime_probe_instrumentation,
    json.proof_ledger?.records?.[0]?.runtimeProbeInstrumentation,
    json.proof_ledger?.records?.[0]?.runtime_probe_instrumentation,
  );
  const sourceAdaptation = sourceAdaptationProofFacet(
    json,
    runtimeProofArtifact,
    ledger.record,
    json.proofLedger?.records?.[0],
    json.proof_ledger?.records?.[0],
    json.contract,
    json.acceptanceContract,
    json.acceptance_contract,
  );
  const telemetry = compactObject(json.gpuProofTelemetry ?? json.gpu_proof_telemetry);
  const visualArtifacts = compactObject(json.visualArtifacts ?? json.visual_oracle_artifacts);
  const visualDelta = compactObject(json.visualDelta ?? json.visual_delta);
  const declaredVisualMetrics = compactObject(json.visualMetrics ?? json.visual_metrics ?? visualArtifacts);
  const visualProofThresholds =
    visualDelta.visualProofThresholds
    ?? visualDelta.visual_proof_thresholds
    ?? declaredVisualMetrics.visualProofThresholds
    ?? declaredVisualMetrics.visual_proof_thresholds;
  const visualMetrics = {
    ...declaredVisualMetrics,
    visualProofThresholds,
    visual_proof_thresholds: visualProofThresholds,
  };
  const visual = await visualArtifactEvidence(
    visualArtifacts,
    context.repoRoot,
    path.dirname(filePath),
    visualMetrics,
    runtimeVisualOracleEvidenceRequirements({
      allowSingleFrameProof: runMode.metricScope === 'cold',
    }),
  );
  const asyncVisualCasBundle = asyncVisualCasBundleFacet(json, visual);
  const metricScope = runMode.metricScope;
  const isCold = metricScope === 'cold';
  const cpuHmrUsed = boolOrNull(json.cpuHmrUsed ?? json.cpu_hmr_used);
  const fullRebuildUsed = boolOrNull(json.fullRebuildUsed ?? json.full_rebuild_used);
  const processRestarted = boolOrNull(json.processRestarted ?? json.process_restarted);
  const noCpuFallback = cpuHmrUsed === false;
  const noFullRebuild = fullRebuildUsed === false;
  const noRestart = processRestarted === false;
  const sourceAdaptedProfile = sourceAdaptation.sourceAdaptedProfile === true;
  const strictRuntimeVisualProfileProof =
    !isCold
    && ledger.present === true
    && ledger.source === 'recomputed_ledger'
    && ledger.gpuHmrSuccess === true
    && ledger.failedInvariants.length === 0
    && runtimeProofArtifactGate.present === true
    && visual.accepted === true
    && runMode.accepted === true
    && noCpuFallback
    && noFullRebuild
    && noRestart
    && (!requiresSourceFirstIngestion || sourceFirstIngestion.accepted === true)
    && (backend !== 'hiprt' || runtimeProbeInstrumentation.accepted === true);
  const strictRuntimeVisualProof =
    strictRuntimeVisualProfileProof === true
    && runtimeProofArtifactGate.accepted === true
    && json.gpuHmrSuccess === true;
  const acceptedRuntime =
    strictRuntimeVisualProof === true
    && sourceAdaptedProfile === false;
  const sourceAdaptedVisualProfileAccepted =
    strictRuntimeVisualProfileProof === true
    && sourceAdaptedProfile === true;
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
    && noRestart
    && (!requiresSourceFirstIngestion || sourceFirstIngestion.accepted === true);
  const matrixOutcome = acceptedRuntime
    ? 'full_runtime_gpu_hmr'
    : sourceAdaptedVisualProfileAccepted
      ? 'visual_profile_accepted'
      : acceptedCold
        ? 'cold_split_proven'
        : 'unproven';
  return finalizeRow({
    artifactSchema: schema,
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId,
    profileId: firstText(
      validationProfileId,
      json.profileId,
      json.profile_id,
      fixtureId,
      targetId === 'unknown' ? null : targetId,
    ) ?? 'unknown',
    fixtureId,
    fixture_id: fixtureId,
    validationProfileId,
    validation_profile_id: validationProfileId,
    proofMode: 'run_mode_proof',
    evidenceKind: isCold
      ? genericRuntimeRunMode
        ? 'cold_runtime_initial_visual_oracle'
        : 'cold_split_visual_oracle'
      : 'visual_oracle',
    matrixOutcome,
    acceptanceClass: acceptedRuntime
      ? 'full_runtime_gpu_hmr'
      : sourceAdaptedVisualProfileAccepted
        ? 'source_adapted_run_mode_visual_profile_not_no_shim_hmr'
        : acceptedCold
          ? 'cold_split_visual_proof'
          : 'run_mode_proof_rejected',
    acceptedForGpuHmr: acceptedRuntime,
    visualProfileAccepted: sourceAdaptedVisualProfileAccepted,
    visual_profile_accepted: sourceAdaptedVisualProfileAccepted,
    sourceAdaptedProfile,
    source_adapted_profile: sourceAdaptedProfile,
    gpuHmrSuccess: acceptedRuntime,
    refusalProven: false,
    proofChainAccepted: acceptedRuntime || sourceAdaptedVisualProfileAccepted || acceptedCold,
    proofChain: acceptedRuntime
      ? 'embedded_runtime_proof_artifact_recomputed_ledger'
      : sourceAdaptedVisualProfileAccepted
        ? 'source_adapted_run_mode_visual_profile_not_no_shim_hmr'
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
    validationProfileEvidence: compactObject(
      json.validationProfileEvidence
        ?? json.validation_profile_evidence
        ?? json.validationProfile
        ?? json.validation_profile
        ?? json.profileEvidence
        ?? json.profile_evidence,
    ),
    runModeCoverageSupport: compactObject(
      json.runModeCoverageSupport
        ?? json.run_mode_coverage_support
        ?? json.coverageSupport
        ?? json.coverage_support,
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
    runtimeProbeInstrumentation,
    runtime_probe_instrumentation: runtimeProbeInstrumentation,
    sourceAdaptation,
    source_adaptation: sourceAdaptation,
    sourceFirstIngestion,
    source_first_ingestion: sourceFirstIngestion,
    asyncVisualCasBundle,
    async_visual_cas_bundle: asyncVisualCasBundle,
    visual,
    runMode,
    cpuHmrUsed,
    fullRebuildUsed,
    processRestarted,
    timings: compactObject(json.timings),
    reasons: matrixOutcome === 'unproven' || sourceAdaptedVisualProfileAccepted ? compactStringList([
      sourceAdaptedVisualProfileAccepted ? 'source_adapted_profile_not_no_shim_gpu_hmr' : null,
      runMode.accepted ? null : 'run_mode_timing_not_accepted',
      visual.accepted ? null : 'visual_artifacts_not_readable',
      isCold || ledger.present ? null : 'embedded_proof_ledger_missing',
      isCold || ledger.source === 'recomputed_ledger' ? null : 'embedded_proof_ledger_not_recomputed',
      isCold || ledger.gpuHmrSuccess === true ? null : 'embedded_proof_ledger_not_accepted',
      isCold || runtimeProofArtifactGate.accepted === true ? null : 'runtime_proof_artifact_not_accepted',
      cpuHmrUsed === false ? null : 'cpu_hmr_firewall_field_not_false',
      fullRebuildUsed === false ? null : 'full_rebuild_firewall_field_not_false',
      processRestarted === false ? null : 'process_restart_firewall_field_not_false',
      !requiresSourceFirstIngestion || sourceFirstIngestion.accepted === true
        ? null
        : 'source_first_ingestion_not_accepted',
      backend === 'hiprt' && !isCold && runtimeProbeInstrumentation.accepted !== true
        ? 'hiprt_profile_instrumentation_disclosure_not_proven'
        : null,
      targetId === 'unknown' ? 'target_identity_not_present_in_run_mode_artifact' : null,
      ...visual.failedGates,
      ...ledger.failedInvariants.map((failure) => failure.code),
      ...runtimeProofArtifactGate.failedGates.map((failure) => failure.code),
      ...(backend === 'hiprt' && !isCold ? runtimeProbeInstrumentation.failedGates : []),
      ...sourceAdaptation.failedGates.map((failure) => failure.code),
      ...(requiresSourceFirstIngestion ? sourceFirstIngestion.failedGates : []),
    ]) : [],
    openGaps: sourceAdaptedVisualProfileAccepted
      ? ['source_adapted_profile_not_no_shim_gpu_hmr']
      : matrixOutcome === 'unproven'
      ? compactStringList([
          'run_mode_proof_not_accepted',
          backend === 'hiprt' && !isCold && runtimeProbeInstrumentation.accepted !== true
            ? 'hiprt_profile_instrumentation_disclosure_required'
            : null,
          requiresSourceFirstIngestion && sourceFirstIngestion.accepted !== true
            ? 'source_first_ingestion_required'
            : null,
          ...visual.failedGates,
          ...sourceAdaptation.failedGates.map((failure) => failure.code),
          ...(requiresSourceFirstIngestion ? sourceFirstIngestion.failedGates : []),
        ])
      : [],
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
  const fixtureId = firstText(json.fixtureId, json.fixture_id);
  const validationProfileId = firstText(json.validationProfileId, json.validation_profile_id);
  const reasons = compactStringList([
    ...(Array.isArray(json.reasons) ? json.reasons : []),
    ...(Array.isArray(json.unsupportedReasons) ? json.unsupportedReasons : []),
    ...(Array.isArray(json.unsupported_reasons) ? json.unsupported_reasons : []),
    firstText(json.reason),
  ]);
  const refusalEvidence = negativeEditRefusalEvidenceFacet(json, { runMode, reasons });
  const sourceFirstIngestion = sourceFirstIngestionFacet(json);
  const refusalProven = refusalEvidence.accepted === true;
  return finalizeRow({
    artifactSchema: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
    artifactPath: relPath(filePath, context.repoRoot),
    updatedAt: context.updatedAt,
    backend,
    targetId,
    profileId: firstText(validationProfileId, json.profileId, json.profile_id, fixtureId, targetId),
    fixtureId,
    fixture_id: fixtureId,
    validationProfileId,
    validation_profile_id: validationProfileId,
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
    runModeCoverageSupport: compactObject(
      json.runModeCoverageSupport
        ?? json.run_mode_coverage_support
        ?? json.coverageSupport
        ?? json.coverage_support,
    ),
    sourceFirstIngestion,
    source_first_ingestion: sourceFirstIngestion,
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
    refusalEvidence,
    refusal_evidence: refusalEvidence,
    cpuHmrUsed: boolOrNull(json.cpuHmrUsed ?? json.cpu_hmr_used) ?? false,
    fullRebuildUsed: boolOrNull(json.fullRebuildUsed ?? json.full_rebuild_used) ?? false,
    processRestarted: boolOrNull(json.processRestarted ?? json.process_restarted) ?? false,
    timings: compactObject(json.timings),
    reasons,
    openGaps: refusalProven
      ? []
      : compactStringList(['negative_edit_refusal_not_proven', ...refusalEvidence.failedGates]),
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

function rowAttemptCompletenessScore(row) {
  return finiteNumber(
    row.attemptCompleteness?.score
    ?? row.attempt_completeness?.score,
  ) ?? 0;
}

function rowUpdatedAtMs(row) {
  const parsed = Date.parse(String(row.updatedAt ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function selectBestRows(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = row.attemptKey ?? rowAttemptKey(row);
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, row);
      continue;
    }
    const priorityDelta = rowPriority(row) - rowPriority(existing);
    const completenessDelta = rowAttemptCompletenessScore(row) - rowAttemptCompletenessScore(existing);
    const updatedDelta = rowUpdatedAtMs(row) - rowUpdatedAtMs(existing);
    if (
      priorityDelta > 0
      || (
        priorityDelta === 0
        && (
          completenessDelta > 0
          || (
            completenessDelta === 0
            && (
              updatedDelta > 0
              || (
                updatedDelta === 0
                && String(row.artifactPath) > String(existing.artifactPath)
              )
            )
          )
        )
      )
    ) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

function selectLatestAttemptRows(rows) {
  const selected = new Map();
  for (const row of rows) {
    const key = row.attemptKey ?? rowAttemptKey(row);
    const existing = selected.get(key);
    if (!existing) {
      selected.set(key, row);
      continue;
    }
    const updatedDelta = rowUpdatedAtMs(row) - rowUpdatedAtMs(existing);
    if (
      updatedDelta > 0
      || (
        updatedDelta === 0
        && String(row.artifactPath) > String(existing.artifactPath)
      )
    ) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

function attemptHistoryRowRef(row) {
  if (!row) return null;
  return compactObject({
    rowId: row.rowId,
    row_id: row.rowId,
    artifactPath: row.artifactPath,
    artifact_path: row.artifactPath,
    updatedAt: row.updatedAt,
    updated_at: row.updatedAt,
    backend: row.backend,
    targetId: row.targetId,
    target_id: row.targetId,
    profileId: row.profileId,
    profile_id: row.profileId,
    proofMode: row.proofMode,
    proof_mode: row.proofMode,
    evidenceKind: row.evidenceKind,
    evidence_kind: row.evidenceKind,
    matrixOutcome: row.matrixOutcome,
    matrix_outcome: row.matrixOutcome,
    attemptCompletenessScore: rowAttemptCompletenessScore(row),
    attempt_completeness_score: rowAttemptCompletenessScore(row),
    openGaps: row.openGaps,
    open_gaps: row.openGaps,
    reasons: row.reasons,
  });
}

function validationAttemptHistory(rows, selectedRows, { enabled = true } = {}) {
  const selectedByAttemptKey = new Map();
  for (const row of selectedRows) {
    selectedByAttemptKey.set(row.attemptKey ?? rowAttemptKey(row), row);
  }
  const attempts = enabled
    ? selectLatestAttemptRows(rows)
      .map((latestRow) => {
        const attemptKey = latestRow.attemptKey ?? rowAttemptKey(latestRow);
        const selectedRow = selectedByAttemptKey.get(attemptKey) ?? null;
        const latestSelected = Boolean(selectedRow && selectedRow.rowId === latestRow.rowId);
        return compactObject({
          attemptKey,
          attempt_key: attemptKey,
          selectedIsLatest: latestSelected,
          selected_is_latest: latestSelected,
          latestAttemptIsUnselected: Boolean(selectedRow && !latestSelected),
          latest_attempt_is_unselected: Boolean(selectedRow && !latestSelected),
          latest: attemptHistoryRowRef(latestRow),
          selected: attemptHistoryRowRef(selectedRow),
        });
      })
      .sort((left, right) => String(left.attemptKey).localeCompare(String(right.attemptKey)))
    : [];
  const latestUnselectedAttemptCount = attempts.filter((attempt) =>
    attempt.latestAttemptIsUnselected === true
  ).length;
  return {
    schemaVersion: 'synthi.gpu_hmr.validation_matrix_attempt_history.v1',
    schema_version: 'synthi.gpu_hmr.validation_matrix_attempt_history.v1',
    enabled,
    authority: enabled ? 'collector_file_mtime' : 'disabled_without_unproven_rows',
    selectionPolicy: 'priority_then_attempt_completeness_then_updated_at_then_artifact_path',
    selection_policy: 'priority_then_attempt_completeness_then_updated_at_then_artifact_path',
    latestPolicy: 'updated_at_then_artifact_path',
    latest_policy: 'updated_at_then_artifact_path',
    attemptCount: attempts.length,
    attempt_count: attempts.length,
    latestUnselectedAttemptCount,
    latest_unselected_attempt_count: latestUnselectedAttemptCount,
    attempts,
  };
}

function rowIsScopedOnlyFullRuntime(row) {
  return acceptedFullRuntimeRow(row)
    && row.claimScope === 'scoped_profile'
    && SCOPED_FULL_RUNTIME_ACCEPTANCE_SCOPES.has(row.acceptanceScope);
}

function rowIsBroadFullRuntime(row) {
  return acceptedFullRuntimeRow(row)
    && row.claimScope === 'broad_library_agnostic'
    && row.acceptanceScope === BROAD_LIBRARY_AGNOSTIC_ACCEPTANCE_SCOPE
    && broadLibraryAgnosticScopeProven(row) === true;
}

function acceptedFullRuntimeRow(row) {
  return row.matrixOutcome === 'full_runtime_gpu_hmr'
    && row.acceptedForGpuHmr === true
    && row.proofChainAccepted === true
    && row.safety?.accepted === true;
}

function fullRuntimeScopeBreakdown(rows) {
  const out = {};
  for (const row of rows) {
    const scope = firstText(row.acceptanceScope, row.acceptance_scope) ?? 'unknown';
    out[scope] = (out[scope] ?? 0) + 1;
  }
  return out;
}

function fullRuntimeGeneralityBreakdown(rows) {
  const out = {};
  for (const row of rows) {
    const generality = compactObject(row.generalityClaim ?? row.generality_claim);
    const claimScope = firstText(
      generality.claimScope,
      generality.claim_scope,
      row.claimScope,
      row.claim_scope,
    ) ?? 'unknown';
    const profileScopedOnly = firstBool(generality.profileScopedOnly, generality.profile_scoped_only);
    const broadAccepted = firstBool(
      generality.broadLibraryAgnosticAccepted,
      generality.broad_library_agnostic_accepted,
    );
    const key = broadAccepted === true
      ? 'broad_library_agnostic'
      : profileScopedOnly === true || claimScope === 'scoped_profile'
        ? 'profile_scoped_only'
        : claimScope;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function rowHasAcceptedComputeEvidence(row) {
  return row.outputOracleFacet?.accepted === true
    || row.output_oracle_facet?.accepted === true
    || row.computeCardOnlyProofAccepted === true
    || row.compute_card_only_proof_accepted === true;
}

function broadLibraryAgnosticReadiness(rows) {
  const fullRuntimeRows = rows.filter(acceptedFullRuntimeRow);
  const scopedRuntimeRows = fullRuntimeRows.filter(rowIsScopedOnlyFullRuntime);
  const broadRuntimeRows = fullRuntimeRows.filter(rowIsBroadFullRuntime);
  const refusalRowsForReadiness = rows.filter((row) => row.matrixOutcome === 'refusal_proven');
  const backends = compactStringList(fullRuntimeRows.map((row) => row.backend));
  const acceptanceScopes = compactStringList(fullRuntimeRows.map((row) => row.acceptanceScope));
  const proofModes = compactStringList(fullRuntimeRows.map((row) => row.proofMode));
  const visualTargets = compactStringList(
    fullRuntimeRows.filter(rowHasAcceptedVisualEvidence).map((row) => row.targetId),
  );
  const computeTargets = compactStringList(
    fullRuntimeRows.filter(rowHasAcceptedComputeEvidence).map((row) => row.targetId),
  );
  const refusalTargets = compactStringList(refusalRowsForReadiness.map((row) => row.targetId));
  const broadRuntimeRowsComputed = true;
  const broadRuntimeRowsMissing = broadRuntimeRows.length === 0;
  const openGaps = compactStringList([
    'matrix_level_broad_generalization_proof_not_present',
    broadRuntimeRowsMissing ? 'broad_runtime_rows_missing' : null,
    backends.length >= 4 ? null : 'broad_acceptance_requires_more_backend_families',
    acceptanceScopes.length >= 4 ? null : 'broad_acceptance_requires_more_acceptance_scopes',
    visualTargets.length > 0 ? null : 'broad_acceptance_requires_visual_oracle_rows',
    computeTargets.length > 0 ? null : 'broad_acceptance_requires_compute_oracle_rows',
    refusalRowsForReadiness.length >= 8 ? null : 'broad_acceptance_requires_adversarial_refusals',
  ]);
  return {
    schemaVersion: 'synthi.gpu_hmr.broad_library_agnostic_readiness.v1',
    authority: 'matrix_computed_not_row_declared',
    accepted: false,
    broadRuntimeRows: broadRuntimeRows.length,
    broad_runtime_rows: broadRuntimeRows.length,
    broadRuntimeRowsComputed,
    broad_runtime_rows_computed: broadRuntimeRowsComputed,
    broadRuntimeRowsMissing,
    broad_runtime_rows_missing: broadRuntimeRowsMissing,
    scopedRuntimeRows: scopedRuntimeRows.length,
    scoped_runtime_rows: scopedRuntimeRows.length,
    acceptedFullRuntimeRows: fullRuntimeRows.length,
    accepted_full_runtime_rows: fullRuntimeRows.length,
    distinctBackendCount: backends.length,
    distinctAcceptanceScopeCount: acceptanceScopes.length,
    distinctProofModeCount: proofModes.length,
    visualOracleTargetCount: visualTargets.length,
    computeOracleTargetCount: computeTargets.length,
    refusalTargetCount: refusalTargets.length,
    backends,
    acceptanceScopes,
    proofModes,
    visualTargets,
    computeTargets,
    refusalTargets,
    openGaps,
  };
}

function coverageSummary(rows) {
  const byOutcome = {};
  const byBackend = {};
  for (const row of rows) {
    byOutcome[row.matrixOutcome] = (byOutcome[row.matrixOutcome] ?? 0) + 1;
    byBackend[row.backend] = (byBackend[row.backend] ?? 0) + 1;
  }
  const fullRuntimeRows = rows.filter(acceptedFullRuntimeRow);
  const scopedRuntimeRows = fullRuntimeRows.filter(rowIsScopedOnlyFullRuntime);
  const broadRuntimeRows = fullRuntimeRows.filter(rowIsBroadFullRuntime);
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
    acceptedFullRuntimeClaimScopeBreakdown: fullRuntimeScopeBreakdown(fullRuntimeRows.map((row) => ({
      ...row,
      acceptanceScope: row.claimScope,
    }))),
    broadFullRuntimeGpuHmrRows: broadRuntimeRows.length,
    broadFullRuntimeTargets: compactStringList(broadRuntimeRows.map((row) => row.targetId)),
    scopedFullRuntimeGpuHmrRows: scopedRuntimeRows.length,
    scopedFullRuntimeTargets: compactStringList(scopedRuntimeRows.map((row) => row.targetId)),
    allFullRuntimeGpuHmrRows: fullRuntimeRows.length,
    allFullRuntimeTargets: compactStringList(fullRuntimeRows.map((row) => row.targetId)),
    fullRuntimeScopeBreakdown: fullRuntimeScopeBreakdown(fullRuntimeRows),
    fullRuntimeGeneralityBreakdown: fullRuntimeGeneralityBreakdown(fullRuntimeRows),
    visualProfileAcceptedRows: visualProfileRows.length,
    visualProfileTargets: compactStringList(visualProfileRows.map((row) => row.targetId)),
    refusalProvenRows: refusalRows.length,
    refusalTargets: compactStringList(refusalRows.map((row) => row.targetId)),
    preflightOnlyRows: preflightRows.length,
    preflightOnlyTargets: compactStringList(preflightRows.map((row) => row.targetId)),
    unprovenRows: unprovenRows.length,
    unprovenTargets: compactStringList(unprovenRows.map((row) => row.targetId)),
    broadLibraryAgnosticReadiness: broadLibraryAgnosticReadiness(rows),
    planCoverage: planCoverage(rows),
  };
}

function dedupeFailedGates(failures) {
  const seen = new Set();
  const out = [];
  for (const failure of failures) {
    const key = stableJson(failure);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(failure);
  }
  return out;
}

function rowWithEvaluatedSafety(row) {
  const suppliedFailures = row.safety?.accepted === false
    ? Array.isArray(row.safety.failedGates) ? row.safety.failedGates : []
    : [];
  const failedGates = dedupeFailedGates([
    ...rowSafetyFailures(row),
    ...suppliedFailures,
  ]);
  return {
    ...row,
    safety: {
      accepted: failedGates.length === 0,
      failedGates,
    },
  };
}

function rowDerivedSummaryFields(summary = {}) {
  const out = {};
  for (const key of Object.keys(coverageSummary([]))) {
    out[key] = summary[key];
  }
  return out;
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
    runModeCoverageSupport: row.runModeCoverageSupport,
    sourceFirstIngestion: row.sourceFirstIngestion,
    source_first_ingestion: row.sourceFirstIngestion,
    asyncVisualCasBundle: row.asyncVisualCasBundle,
    async_visual_cas_bundle: row.asyncVisualCasBundle,
    validationProfileEvidence: row.validationProfileEvidence,
    externalProfileSelection: row.externalProfileSelection,
    externalSourceDelta: row.externalSourceDelta,
    externalVisualProofArtifact: row.externalVisualProofArtifact,
    proofMode: row.proofMode,
    acceptanceClass: row.acceptanceClass,
    supportedPipelineScope: row.supportedPipelineScope,
    acceptanceScope: row.acceptanceScope,
    claimScope: row.claimScope,
    generalityClaim: row.generalityClaim ?? row.generality_claim,
    fullRuntimeEvidenceAuthority: row.fullRuntimeEvidenceAuthority ?? row.full_runtime_evidence_authority,
    claimBoundaryAccepted: row.claimBoundaryAccepted,
    negativeAbiRefusalAccepted: row.negativeAbiRefusalAccepted,
    validationTargetScope: row.validationTargetScope,
    coverageObligations: row.coverageObligations,
  }));
}

function claimScopeForRows(rows) {
  const scopes = compactStringList(rows.map((row) => row.claimScope));
  if (scopes.length === 0) return null;
  if (scopes.length === 1) return scopes[0];
  if (scopes.includes('broad_library_agnostic')) return 'mixed_includes_broad';
  if (scopes.every((scope) => scope === 'scoped_profile' || scope === 'not_full_runtime')) {
    return 'scoped_profile_with_support';
  }
  return 'mixed_claim_scope';
}

function coverageEntry({ id, requirement, status, rows = [], openGaps = [], ...extra }) {
  return compactObject({
    id,
    requirement,
    status,
    claimScope: extra.claimScope ?? claimScopeForRows(rows),
    claim_scope: extra.claimScope ?? claimScopeForRows(rows),
    acceptanceScopes: compactStringList(rows.map((row) => row.acceptanceScope)),
    acceptance_scopes: compactStringList(rows.map((row) => row.acceptanceScope)),
    rowCount: rows.length,
    rows: rowRefs(rows),
    openGaps: compactStringList(openGaps),
    ...extra,
  });
}

function acceptedRows(rows, predicate) {
  return rows.filter((row) => acceptedFullRuntimeRow(row) && predicate(row));
}

function hipModuleScopedScopeAccepted(scope) {
  return scope === 'explicit-hip-module-float32-readback'
    || scope === 'explicit-hip-module-declared-readback';
}

function hipModuleScopedRuntimeCoverage(rows) {
  const hipModuleRows = acceptedRows(rows, (row) =>
    row.backend === 'hip'
    && row.proofMode === 'hip_module_runtime_readback'
    && hipModuleScopedScopeAccepted(row.supportedPipelineScope)
    && row.claimBoundaryAccepted === true
    && row.negativeAbiRefusalAccepted === true
    && row.runtimeTimestampProof?.accepted === true
    && row.epoch2ArtifactHashProof?.accepted === true
    && row.computeCardOnlyProofAccepted === true
  );
  const groups = new Map();
  for (const row of hipModuleRows) {
    const key = canonicalTargetKey(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const acceptedGroups = [];
  const incompleteGroups = [];
  for (const [key, groupRows] of groups) {
    const hot1 = groupRows.find((row) => row.runMode?.metricScope === 'hot_delta_1');
    const hot2 = groupRows.find((row) =>
      row.runMode?.metricScope === 'hot_delta_2'
      && row.runMode?.differentEdit === true
    );
    const hot1Hash = firstText(hot1?.runMode?.editHash, hot1?.runMode?.edit_hash);
    const hot2Hash = firstText(hot2?.runMode?.editHash, hot2?.runMode?.edit_hash);
    const distinctHotEdits = Boolean(hot1Hash && hot2Hash && hot1Hash !== hot2Hash);
    const negativeRefusal = groupRows.some((row) => row.negativeAbiRefusalAccepted === true);
    const accepted = Boolean(hot1 && hot2 && distinctHotEdits && negativeRefusal);
    const record = {
      key,
      rows: groupRows,
      hot1,
      hot2,
      distinctHotEdits,
      negativeRefusal,
      openGaps: compactStringList([
        hot1 ? null : 'hip_module_hot_delta_1_required',
        hot2 ? null : 'hip_module_hot_delta_2_different_edit_required',
        distinctHotEdits ? null : 'hip_module_hot_delta_edit_hashes_not_distinct',
        negativeRefusal ? null : 'hip_module_negative_abi_refusal_required',
      ]),
    };
    if (accepted) acceptedGroups.push(record);
    else incompleteGroups.push(record);
  }
  const acceptedRowsForCoverage = acceptedGroups.flatMap((group) => group.rows);
  const incompleteRows = incompleteGroups.flatMap((group) => group.rows);
  if (acceptedGroups.length > 0) {
    return coverageEntry({
      id: 'hip_module_scoped_runtime_readback',
      requirement: 'Scoped HIP module-load/runtime readback proof with hot1, hot2 different edit, and executable ABI-negative refusal',
      status: 'accepted',
      rows: acceptedRowsForCoverage,
      openGaps: [],
      acceptedTargetCount: acceptedGroups.length,
      incompleteTargetCount: incompleteGroups.length,
    });
  }
  if (incompleteRows.length > 0) {
    return coverageEntry({
      id: 'hip_module_scoped_runtime_readback',
      requirement: 'Scoped HIP module-load/runtime readback proof with hot1, hot2 different edit, and executable ABI-negative refusal',
      status: 'incomplete',
      rows: incompleteRows,
      openGaps: compactStringList(incompleteGroups.flatMap((group) => group.openGaps)),
      acceptedTargetCount: 0,
      incompleteTargetCount: incompleteGroups.length,
    });
  }
  return coverageEntry({
    id: 'hip_module_scoped_runtime_readback',
    requirement: 'Scoped HIP module-load/runtime readback proof with hot1, hot2 different edit, and executable ABI-negative refusal',
    status: 'missing',
    openGaps: ['hip_module_runtime_readback_required'],
    acceptedTargetCount: 0,
    incompleteTargetCount: 0,
  });
}

function rowHasAcceptedVisualEvidence(row) {
  return row.visual?.present === true && row.visual?.accepted === true;
}

function rowHasAcceptedExternalProjectContract(row, options = {}) {
  const contract = compactObject(row.externalProjectContract ?? row.external_project_contract);
  if (contract.accepted !== true) return false;
  if (options.profileClass && contract.profileClass !== options.profileClass && contract.profile_class !== options.profileClass) {
    return false;
  }
  if (options.backend && row.backend !== options.backend) return false;
  return true;
}

function rowCanCountBackendSpecificCoverage(row) {
  if (row.proofMode === 'runtime_preflight') {
    return preflightBackendEvidenceAccepted(row);
  }
  return true;
}

function refusalRows(rows, predicate) {
  return rows.filter((row) =>
    row.matrixOutcome === 'refusal_proven'
    && rowCanCountBackendSpecificCoverage(row)
    && predicate(row)
  );
}

function preflightOnlyRows(rows, predicate) {
  return rows.filter((row) =>
    row.matrixOutcome === 'preflight_only'
    && rowCanCountBackendSpecificCoverage(row)
    && predicate(row)
  );
}

function visualProfileRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'visual_profile_accepted' && predicate(row));
}

function deterministicFissionRows(rows, predicate) {
  return rows.filter((row) => row.matrixOutcome === 'deterministic_fission_proven' && predicate(row));
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
  const fullRuntimeRowsByTarget = new Map();
  for (const row of fullRuntimeRows) {
    appendTargetRow(rowsByTarget, row);
    appendTargetRow(fullRuntimeRowsByTarget, row);
  }
  const negativeEditRows = refusalRows(rows, (row) =>
    row.proofMode === 'negative_edit'
    || row.evidenceKind === 'negative_edit'
    || row.runMode?.metricScope === 'negative_edit'
  );
  const {
    attachedRows: attachedColdRows,
    unlinkedRows: unlinkedColdRows,
  } = attachLinkedRunModeSupportRows({
    rowsByTarget,
    fullRuntimeRowsByTarget,
    supportRows: coldRows,
  });
  const {
    attachedRows: attachedNegativeEditRows,
    unlinkedRows: unlinkedNegativeEditRows,
  } = attachLinkedRunModeSupportRows({
    rowsByTarget,
    fullRuntimeRowsByTarget,
    supportRows: negativeEditRows,
  });
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
    unlinkedSupportRowCount: unlinkedColdRows.length + unlinkedNegativeEditRows.length,
    unlinked_support_row_count: unlinkedColdRows.length + unlinkedNegativeEditRows.length,
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
  const fullRuntimeRowsByTarget = new Map();
  for (const row of fullRuntimeRows) {
    appendTargetRow(rowsByTarget, row);
    appendTargetRow(fullRuntimeRowsByTarget, row);
  }

  const fullRuntimeRowIds = new Set(fullRuntimeRows.map((row) => row.rowId));
  const candidateSupportRows = rows.filter((row) =>
    row.backend === backend
    && !fullRuntimeRowIds.has(row.rowId)
    && row.runMode?.accepted === true
  );
  const {
    attachedRows: supportRows,
    unlinkedRows: unlinkedSupportRows,
  } = attachLinkedRunModeSupportRows({
    rowsByTarget,
    fullRuntimeRowsByTarget,
    supportRows: candidateSupportRows,
  });

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
    unlinkedSupportRowCount: unlinkedSupportRows.length,
    unlinked_support_row_count: unlinkedSupportRows.length,
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

const ROCM_LOCAL_BACKENDS = new Set(['hip', 'hiprt', 'oidn_hip']);

function rowCarriesRocmEvidence(row) {
  if (ROCM_LOCAL_BACKENDS.has(row.backend)) return true;
  const deviceIdentity = compactObject(row.deviceIdentity ?? row.device_identity);
  const runtimeCapability = compactObject(row.runtimeCapabilityPreflight ?? row.runtime_capability_preflight);
  const backendEvidence = compactObject(row.typedBackendEvidence ?? row.typed_backend_evidence);
  const raw = [
    row.backend,
    row.proofMode,
    deviceIdentity.backend,
    deviceIdentity.vendor,
    deviceIdentity.device_uuid,
    deviceIdentity.deviceUuid,
    deviceIdentity.gpu_arch,
    deviceIdentity.gpuArch,
    deviceIdentity.compile_target,
    deviceIdentity.compileTarget,
    runtimeCapability.backend,
    runtimeCapability.backendFamily,
    runtimeCapability.backend_family,
    runtimeCapability.vendor,
    backendEvidence.backend,
    backendEvidence.backendFamily,
    backendEvidence.backend_family,
  ].map((value) => String(value ?? '').toLowerCase());
  return raw.some((value) =>
    value.includes('rocm')
    || value.includes('hip')
    || /^gfx[0-9][0-9a-z]*$/u.test(value)
  );
}

function cudaRuntimeCoverage(rows) {
  const cudaRows = rows.filter((row) => row.backend === 'cuda');
  if (cudaRows.length > 0) {
    return acceptedOrRefusedCoverage({
      rows,
      id: 'cuda_runtime',
      requirement: 'CUDA runtime proof on CUDA hardware',
      acceptedPredicate: (row) => row.backend === 'cuda',
      missingGap: 'cuda_hardware_required',
    });
  }
  const rocmEvidenceRows = rows.filter(rowCarriesRocmEvidence);
  if (rocmEvidenceRows.length > 0) {
    return coverageEntry({
      id: 'cuda_runtime',
      requirement: 'CUDA runtime proof on CUDA hardware',
      status: 'not_applicable',
      rows: rocmEvidenceRows,
      openGaps: [],
      notApplicable: true,
      not_applicable: true,
      hardwareScope: 'rocm_amd_local_run',
      hardware_scope: 'rocm_amd_local_run',
      reason: 'cuda_requires_cuda_hardware_and_this_matrix_contains_rocm_amd_evidence',
      observedBackends: [...new Set(rocmEvidenceRows.map((row) => row.backend).filter(Boolean))].sort(),
      observed_backends: [...new Set(rocmEvidenceRows.map((row) => row.backend).filter(Boolean))].sort(),
    });
  }
  return coverageEntry({
    id: 'cuda_runtime',
    requirement: 'CUDA runtime proof on CUDA hardware',
    status: 'missing',
    openGaps: ['cuda_hardware_required'],
  });
}

function realRocmCoverageContractAudit(
  rows,
  {
    gateKeys = [],
    facetKeys = [],
    requiredWhenPresent = false,
    provenStatus = 'contract_proven',
    missingOrUnprovenStatus = 'contract_missing_or_unproven',
  } = {},
) {
  const gates = compactObjectList(rows.flatMap((row) =>
    gateKeys.map((key) => compactObject(row[key]))
  ));
  const facets = compactObjectList(rows.flatMap((row) =>
    facetKeys.map((key) => compactObject(row[key]))
  ));
  const required = gates.some((gate) => gate.required === true)
    || facets.some((facet) =>
      facet.required === true
      || facet.declared === true
      || facet.appHookRequired === true
      || facet.app_hook_required === true
    )
    || (requiredWhenPresent && (gates.length > 0 || facets.length > 0));
  const present = gates.length > 0 || facets.length > 0;
  const listEntries = (entry) => [
    ...(Array.isArray(entry.failedGaps) ? entry.failedGaps : []),
    ...(Array.isArray(entry.failed_gaps) ? entry.failed_gaps : []),
    ...(Array.isArray(entry.failedGates) ? entry.failedGates : []),
    ...(Array.isArray(entry.failed_gates) ? entry.failed_gates : []),
    ...(Array.isArray(entry.blockingGaps) ? entry.blockingGaps : []),
    ...(Array.isArray(entry.blocking_gaps) ? entry.blocking_gaps : []),
  ];
  const entryHasBlockingProofGaps = (entry) => listEntries(entry).length > 0;
  const proven = gates.some((gate) =>
    !entryHasBlockingProofGaps(gate)
    && (gate.accepted === true || gate.proven === true)
  ) || facets.some((facet) =>
    !entryHasBlockingProofGaps(facet)
    && (
      facet.accepted === true
      || facet.canSatisfyRuntimeProof === true
      || facet.can_satisfy_runtime_proof === true
      || facet.runtimeConsistencyAccepted === true
      || facet.runtime_consistency_accepted === true
    )
  );
  const statusValues = compactStringList([
    ...gates.map((gate) => firstText(gate.status, gate.reason)),
    ...facets.map((facet) => firstText(facet.status, facet.reason)),
  ]);
  const blockingGaps = compactStringList([...gates, ...facets]
    .flatMap(listEntries)
    .map((value) => firstText(value, compactObject(value).code)));
  return {
    present,
    required,
    proven,
    accepted: !required || proven,
    status: proven
      ? provenStatus
      : required
        ? missingOrUnprovenStatus
        : 'not_required',
    facetStatuses: statusValues,
    facet_statuses: statusValues,
    blockingGaps,
    blocking_gaps: blockingGaps,
  };
}

function realRocmRepositoryTargetCoverage(rows) {
  const candidates = rows.filter((row) =>
    row.proofMode === 'real_rocm_repo_validation'
    && (acceptedFullRuntimeRow(row) || row.matrixOutcome === 'refusal_proven')
  );
  const byTarget = new Map();
  for (const row of candidates) {
    const targetId = firstText(row.targetId, row.profileId, row.artifactPath);
    if (!targetId) continue;
    const targetRows = byTarget.get(targetId) ?? [];
    targetRows.push(row);
    byTarget.set(targetId, targetRows);
  }
  return [...byTarget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetId, targetRows]) => {
      const accepted = targetRows.filter((row) => acceptedFullRuntimeRow(row));
      const refused = targetRows.filter((row) => row.matrixOutcome === 'refusal_proven');
      const status = accepted.length > 0 ? 'accepted' : refused.length > 0 ? 'refused' : 'missing';
      const appHookContractAudit = realRocmCoverageContractAudit(targetRows, {
        gateKeys: ['realRocmAppHookContractGate', 'real_rocm_app_hook_contract_gate'],
        facetKeys: ['realRocmAppHookContract', 'real_rocm_app_hook_contract'],
        missingOrUnprovenStatus: 'contract_missing_or_unproven',
      });
      const appHookMaterializationAudit = realRocmCoverageContractAudit(targetRows, {
        gateKeys: [
          'realRocmAppHookMaterializationGate',
          'real_rocm_app_hook_materialization_gate',
        ],
        facetKeys: [
          'realRocmAppHookMaterialization',
          'real_rocm_app_hook_materialization',
          'appHookMaterialization',
          'app_hook_materialization',
        ],
        missingOrUnprovenStatus: 'materialization_missing_or_unproven',
      });
      const sameProcessRuntimeOracleAudit = realRocmCoverageContractAudit(targetRows, {
        gateKeys: ['realRocmSameProcessRuntimeOracleGate', 'real_rocm_same_process_runtime_oracle_gate'],
        facetKeys: ['realRocmSameProcessRuntimeOracle', 'real_rocm_same_process_runtime_oracle'],
        missingOrUnprovenStatus: 'contract_missing_or_unproven',
      });
      const deviceSidecarContractAudit = realRocmCoverageContractAudit(targetRows, {
        facetKeys: ['realRocmDeviceSidecarContract', 'real_rocm_device_sidecar_contract'],
        requiredWhenPresent: true,
        missingOrUnprovenStatus: 'device_sidecar_missing_or_unproven',
      });
      const sidecarRuntimeConsistencyAudit = realRocmCoverageContractAudit(targetRows, {
        gateKeys: ['realRocmSidecarRuntimeConsistencyGate', 'real_rocm_sidecar_runtime_consistency_gate'],
        facetKeys: ['realRocmSidecarRuntimeConsistency', 'real_rocm_sidecar_runtime_consistency'],
        requiredWhenPresent: true,
        provenStatus: 'consistency_proven',
        missingOrUnprovenStatus: 'consistency_missing_or_unproven',
      });
      return coverageEntry({
        id: `large_real_rocm_repo:${targetId}`,
        requirement: `Large real ROCm repository target ${targetId} validation with full-runtime proof gating`,
        status,
        rows: accepted.length > 0 ? accepted : refused,
        openGaps: status === 'accepted'
          ? []
          : compactStringList(refused.flatMap((row) => row.openGaps)),
        appHookContract: appHookContractAudit,
        app_hook_contract: appHookContractAudit,
        appHookMaterialization: appHookMaterializationAudit,
        app_hook_materialization: appHookMaterializationAudit,
        sameProcessRuntimeOracleContract: sameProcessRuntimeOracleAudit,
        same_process_runtime_oracle_contract: sameProcessRuntimeOracleAudit,
        deviceSidecarContract: deviceSidecarContractAudit,
        device_sidecar_contract: deviceSidecarContractAudit,
        sidecarRuntimeConsistency: sidecarRuntimeConsistencyAudit,
        sidecar_runtime_consistency: sidecarRuntimeConsistencyAudit,
        targetId,
        target_id: targetId,
      });
    });
}

function planCoverage(rows) {
  const hipRuntimeRows = acceptedRows(rows, (row) =>
    row.backend === 'hip'
    && row.proofMode !== 'hip_module_runtime_readback'
  );
  const hiprtRows = acceptedRows(rows, (row) =>
    row.backend === 'hiprt'
    && rowHasAcceptedVisualEvidence(row)
    && row.acceptanceScope === 'hiprt_declared_visual_profile'
    && row.runtimeProbeInstrumentation?.accepted === true
  );
  const webgpuRuntimeRows = acceptedRows(rows, (row) =>
    row.backend === 'webgpu'
    && rowHasAcceptedVisualEvidence(row)
    && row.proofMode !== 'webgpu_wgsl_runtime_compute'
  );
  const webgpuComputeRows = acceptedRows(rows, (row) =>
    row.backend === 'webgpu'
    && row.proofMode === 'webgpu_wgsl_runtime_compute'
    && row.outputOracleFacet?.kind === 'compute_oracle'
    && row.outputOracleFacet?.accepted === true
  );
  const webgpuEmptyLayoutRows = acceptedRows(rows, (row) =>
    row.backend === 'webgpu'
    && row.supportedPipelineScope === 'explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list'
    && row.declaredScopeEvidence?.accepted === true
  );
  const webgpuProfiledLayoutRows = acceptedRows(rows, (row) =>
    row.backend === 'webgpu'
    && row.supportedPipelineScope === 'explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list'
    && row.declaredScopeEvidence?.accepted === true
    && row.runtimeResourceTrace?.resourceStateHash
    && row.runtimeResourceTrace?.bindGroupCount > 0
    && row.runtimeResourceTrace?.vertexBufferCount > 0
  );
  const oidnHipPreflightRows = preflightOnlyRows(rows, (row) => row.backend === 'oidn_hip');
  const webgpuPreflightRows = preflightOnlyRows(rows, (row) => row.backend === 'webgpu');
  const externalVisualRows = visualProfileRows(rows, (row) =>
    rowHasAcceptedVisualEvidence(row)
    && rowHasAcceptedExternalProjectContract(row, { profileClass: 'external_engine_visual_profile' })
  );
  const sourceFirstFullRuntimeRows = acceptedRows(rows, (row) =>
    row.sourceFirstIngestion?.accepted === true
    && row.sourceFirstIngestion?.proofAuthority === AGENT_SPLIT_SOURCE_FIRST_INGESTION_AUTHORITY
    && row.sourceFirstIngestion?.acceptedForGpuHmr === false
    && row.sourceFirstIngestion?.gpuHmrSuccess === false
    && row.sourceFirstIngestion?.canSatisfyRuntimeProof === false
    && row.asyncVisualCasBundle?.accepted === true
    && row.asyncVisualCasBundle?.acceptedForGpuHmr === false
    && row.asyncVisualCasBundle?.gpuHmrSuccess === false
    && row.asyncVisualCasBundle?.proofAuthority === ASYNC_VISUAL_CAS_SUPPORT_AUTHORITY
    && row.fullRuntimeEvidenceAuthority?.accepted === true
    && (
      row.fullRuntimeEvidenceAuthority?.visualOracleAccepted === true
      || row.fullRuntimeEvidenceAuthority?.computeOracleAccepted === true
      || row.outputOracleFacet?.accepted === true
    )
  );
  const fissionRows = deterministicFissionRows(rows, () => true);

  return [
    coverageEntry({
      id: 'rocm_hip_full_runtime',
      requirement: 'Generated/profiled ROCm/HIP device-artifact full-runtime proof-ledger acceptance',
      status: hipRuntimeRows.length > 0 ? 'accepted' : 'missing',
      rows: hipRuntimeRows,
      openGaps: hipRuntimeRows.length > 0 ? [] : ['hip_full_runtime_ledger_required'],
    }),
    hipModuleScopedRuntimeCoverage(rows),
    ...validationProfileCoverageEntries(rows),
    coverageEntry({
      id: 'source_first_uncompiled_project_validation',
      requirement: 'Source-first uncompiled project ingestion through split, compile, runtime proof, and output oracle',
      status: sourceFirstFullRuntimeRows.length > 0 ? 'accepted' : 'missing',
      rows: sourceFirstFullRuntimeRows,
      openGaps: sourceFirstFullRuntimeRows.length > 0
        ? []
        : ['source_first_full_runtime_visual_or_compute_proof_with_async_cas_support_required'],
      proofAuthority: AGENT_SPLIT_SOURCE_FIRST_INGESTION_AUTHORITY,
      proof_authority: AGENT_SPLIT_SOURCE_FIRST_INGESTION_AUTHORITY,
      sourceFirstEvidenceAuthority: 'source_first_provenance_only_plus_strict_runtime_ledger',
      source_first_evidence_authority: 'source_first_provenance_only_plus_strict_runtime_ledger',
      asyncVisualCasSupportAuthority: ASYNC_VISUAL_CAS_SUPPORT_AUTHORITY,
      async_visual_cas_support_authority: ASYNC_VISUAL_CAS_SUPPORT_AUTHORITY,
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
      id: 'oidn_hip_runtime_preflight',
      requirement: 'OIDN HIP runtime capability preflight without output-oracle overclaim',
      status: oidnHipPreflightRows.length > 0 ? 'preflight_only' : 'missing',
      rows: oidnHipPreflightRows,
      openGaps: oidnHipPreflightRows.length > 0
        ? compactStringList(oidnHipPreflightRows.flatMap((row) => row.openGaps))
        : ['oidn_hip_runtime_preflight_required'],
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
    ...realRocmRepositoryTargetCoverage(rows),
    acceptedOrRefusedCoverage({
      rows,
      id: 'bevy_file_loaded_wgsl',
      requirement: 'Bevy file-loaded WGSL full-runtime proof',
      acceptedPredicate: (row) =>
        row.backend === 'bevy_wgsl'
        && (
          row.acceptedForGpuHmr === true
          || rowHasAcceptedExternalProjectContract(row, {
            backend: 'bevy_wgsl',
            profileClass: 'engine_asset_reload_visual_profile',
          })
        ),
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
    cudaRuntimeCoverage(rows),
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
  const evaluatedRows = rows.map(rowWithEvaluatedSafety);
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
  const rowIdentityFailuresByIndex = new Map();
  evaluatedRows.forEach((row, index) => {
    const identityFailures = [];
    if (row.schemaVersion !== GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION) {
      failures.push({ code: 'validation_matrix_row_schema_mismatch', row_index: index });
    }
    const expectedRowId = rowIdFor(row);
    if (!row.rowId) {
      identityFailures.push({ code: 'validation_matrix_row_id_missing' });
    } else if (row.rowId !== expectedRowId) {
      identityFailures.push({
        code: 'validation_matrix_row_id_mismatch',
        suppliedRowId: row.rowId,
        recomputedRowId: expectedRowId,
      });
    }
    if (identityFailures.length > 0) {
      rowIdentityFailuresByIndex.set(index, identityFailures);
      failures.push(...identityFailures.map((failure) => ({
        ...failure,
        row_index: index,
        targetId: row.targetId,
      })));
    }
    for (const failure of row.safety.failedGates) {
      failures.push({ ...failure, row_index: index, targetId: row.targetId });
    }
  });
  const summaryRows = evaluatedRows.map((row, index) => {
    const identityFailures = rowIdentityFailuresByIndex.get(index) ?? [];
    if (identityFailures.length === 0) return row;
    return {
      ...row,
      safety: {
        accepted: false,
        failedGates: dedupeFailedGates([
          ...identityFailures,
          ...(Array.isArray(row.safety?.failedGates) ? row.safety.failedGates : []),
        ]),
      },
    };
  });
  const recomputedSummary = coverageSummary(summaryRows);
  const suppliedSummary = compactObject(ledger.summary);
  if (Object.keys(suppliedSummary).length > 0) {
    const suppliedRowDerivedSummary = rowDerivedSummaryFields(suppliedSummary);
    if (stableJson(suppliedRowDerivedSummary) !== stableJson(recomputedSummary)) {
      failures.push({
        code: 'validation_matrix_summary_mismatch',
        suppliedSummaryHash: sha256Hex(stableJson(suppliedRowDerivedSummary)),
        recomputedSummaryHash: sha256Hex(stableJson(recomputedSummary)),
      });
    }
  }
  const summaryForProofId = Object.keys(suppliedSummary).length > 0
    ? ledger.summary
    : recomputedSummary;
  const suppliedAttemptHistory = compactObject(ledger.attemptHistory ?? ledger.attempt_history);
  const recomputedProofId = proofIdFor('gpu-validation-matrix-ledger', {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    rows: rows.map((row) => row.rowId),
    summary: summaryForProofId,
    attemptHistory: suppliedAttemptHistory,
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
    summary: Object.keys(suppliedSummary).length > 0 ? ledger.summary : recomputedSummary,
    attemptHistory: suppliedAttemptHistory,
    attempt_history: suppliedAttemptHistory,
  };
}

export function buildGpuHmrValidationMatrixLedger(rows, options = {}) {
  const safetyEvaluatedRows = rows.map(rowWithEvaluatedSafety);
  const selectedRows = options.latestPerTarget === false ? safetyEvaluatedRows : selectBestRows(safetyEvaluatedRows);
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
  const attemptHistory = validationAttemptHistory(safetyEvaluatedRows, selectedRows, {
    enabled: options.includeUnproven === true,
  });
  const seed = {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    latestPerTarget: options.latestPerTarget !== false,
    includeUnproven: options.includeUnproven === true,
    sourceRoots: options.sourceRoots ?? [],
    summary,
    attemptHistory,
    attempt_history: attemptHistory,
    rows: includedRows,
  };
  const proofId = proofIdFor('gpu-validation-matrix-ledger', {
    schemaVersion: seed.schemaVersion,
    rows: includedRows.map((row) => row.rowId),
    summary,
    attemptHistory,
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
