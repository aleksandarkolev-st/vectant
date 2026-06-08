import { createHash } from 'node:crypto';
import { evaluateGpuHmrDeterministicVisualMode } from './gpu-hmr-visual-evidence.mjs';

export const GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION = 'synthi.gpu.hmr.proof_ledger.v1';

const GPU_PROJECT_KINDS = new Set(['gpu_project', 'mixed_project']);
const GPU_ARTIFACT_EDIT_KINDS = new Set(['gpu_artifact_edit']);
const SUPPORTED_BACKENDS = new Set([
  'hip',
  'hiprt',
  'opencl',
  'vulkan',
  'webgpu',
  'bevy_wgsl',
  'cuda',
  'sycl',
]);
const VISUAL_OR_ENGINE_BACKENDS = new Set(['hiprt', 'vulkan', 'webgpu', 'bevy_wgsl']);
const METRIC_CLOCKS = new Set(['monotonic_ns']);
const METRIC_SCOPES = new Set(['cold', 'warm', 'hot_delta_1', 'hot_delta_2']);
const CACHE_STATES = new Set(['clean', 'compiler_cache_warm', 'pipeline_cache_warm']);
const MODEL_AVAILABILITY_BASES = new Set([
  'static_registry',
  'static_registry+live_model_list',
  'live_model_list',
  'live_model_list_registry_override',
  'private_alias_env',
]);
const REQUIRED_MODEL_PROVIDER = 'google_gemini';
const REQUIRED_MODEL_BY_ROLE = {
  split: 'gemini-3.5-flash',
  gpu_delta: 'gemini-3.1-flash-lite',
};
const REQUIRED_TIMING_FIELDS = [
  ['static_discovery_time', 'staticDiscoveryTime'],
  ['ai_contract_synthesis_time', 'aiContractSynthesisTime'],
  ['model_availability_check_time', 'modelAvailabilityCheckTime'],
  ['artifact_hash_time', 'artifactHashTime'],
  ['adapter_generation_time', 'adapterGenerationTime'],
  ['device_compile_wall_time', 'deviceCompileWallTime'],
  ['artifact_load_time', 'artifactLoadTime'],
  ['epoch_publish_time', 'epochPublishTime'],
  ['dispatch_trace_time', 'dispatchTraceTime'],
  ['runtime_probe_time', 'runtimeProbeTime'],
  ['oracle_analysis_time', 'oracleAnalysisTime'],
  ['trigger_to_visible_time', 'triggerToVisibleTime'],
  ['screenshot_capture_time', 'screenshotCaptureTime'],
  ['dispatch_to_output_proof_time', 'dispatchToOutputProofTime'],
  ['total_validator_wall_time', 'totalValidatorWallTime'],
];

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

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asBool(value) {
  return value === true;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function firstPresent(...entries) {
  for (const [object, key] of entries) {
    if (object && typeof object === 'object' && hasOwn(object, key)) {
      return { present: true, value: object[key] };
    }
  }
  return { present: false, value: undefined };
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function compactStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(text)
    .filter(Boolean))];
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
}

function enumText(value) {
  if (typeof value === 'string') return text(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return text(value.value);
  }
  return null;
}

function hasOwnDeep(object, key) {
  return object && typeof object === 'object' && !Array.isArray(object) && hasOwn(object, key);
}

function valueRecorded(object, key) {
  if (!hasOwnDeep(object, key)) return false;
  const value = object[key];
  if (value === null) return true;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteNonNegativeNumber(value) {
  const n = finiteNumber(value);
  return n !== null && n >= 0 ? n : null;
}

function timingObjectCandidates(timings, timingMetrics = {}) {
  const t = asObject(timings);
  const m = asObject(timingMetrics);
  const nestedTimingMetrics = asObject(t.timing_metrics ?? t.timingMetrics);
  return [
    t,
    m,
    nestedTimingMetrics,
    asObject(t.normalized_timings),
    asObject(t.normalizedTimings),
    asObject(m.normalized_timings),
    asObject(m.normalizedTimings),
    asObject(nestedTimingMetrics.normalized_timings),
    asObject(nestedTimingMetrics.normalizedTimings),
    asObject(t.snake_case),
    asObject(asObject(t.normalizedTimings).snake_case),
    asObject(asObject(m.normalizedTimings).snake_case),
    asObject(asObject(nestedTimingMetrics.normalizedTimings).snake_case),
  ];
}

function timingFieldValue(timings, timingMetrics, snakeKey, camelKey) {
  const candidates = timingObjectCandidates(timings, timingMetrics);
  for (const object of candidates) {
    for (const key of [snakeKey, `${snakeKey}_ms`, camelKey, `${camelKey}Ms`]) {
      if (!hasOwnDeep(object, key)) continue;
      const value = finiteNonNegativeNumber(object[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function collectTimingFieldValues(timings, timingMetrics) {
  return Object.fromEntries(REQUIRED_TIMING_FIELDS.map(([snakeKey, camelKey]) => [
    snakeKey,
    timingFieldValue(timings, timingMetrics, snakeKey, camelKey),
  ]));
}

function eventId(event) {
  return firstText(event.id, event.event_id, event.dispatch_id, event.proof_id, event.proofId);
}

function eventEpoch(event) {
  return firstText(event.epoch, event.epoch_id, event.epochId, event.generation);
}

function eventArtifactHash(event) {
  return firstText(
    event.artifact_hash,
    event.artifactHash,
    event.artifact_id,
    event.artifactId,
    event.loaded_artifact_hash,
    event.loadedArtifactHash,
    event.loaded_artifact_id,
    event.loadedArtifactId,
    event.published_artifact_hash,
    event.publishedArtifactHash,
    event.published_artifact_id,
    event.publishedArtifactId,
    event.runtime_artifact_id,
    event.runtimeArtifactId,
    event.selected_artifact_id,
    event.selectedArtifactId,
    event.new_artifact_hash,
    event.newArtifactHash,
    event.hash,
  );
}

function eventProcessId(event) {
  return firstText(event.process_id, event.processId, event.pid);
}

function eventTimestamp(event) {
  return finiteNumber(
    event.timestamp_monotonic_ns
    ?? event.timestampMonotonicNs
    ?? event.timestamp_ms
    ?? event.timestampMs
    ?? event.ts
  );
}

function outputAfterDispatchId(outputEvent) {
  return firstText(
    outputEvent.after_dispatch_id,
    outputEvent.afterDispatchId,
    outputEvent.dispatch_id,
    outputEvent.dispatchId,
  );
}

function outputKind(outputEvent) {
  return String(firstText(outputEvent.kind, outputEvent.oracle_kind, outputEvent.oracleKind) ?? '')
    .trim()
    .toLowerCase();
}

function isVisualOutput(outputEvent) {
  const kind = outputKind(outputEvent);
  return kind.includes('visual')
    || kind.includes('render')
    || kind.includes('frame')
    || kind.includes('pixel')
    || asObject(outputEvent.visual_oracle_artifacts ?? outputEvent.visualOracleArtifacts).after_image;
}

function outputOracleTarget(record) {
  const outputEvent = asObject(record.output_event ?? record.outputEvent);
  const outputOracle = asObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
  return asObject(
    record.output_oracle_target
    ?? record.outputOracleTarget
    ?? outputEvent.output_oracle_target
    ?? outputEvent.outputOracleTarget
    ?? outputOracle.output_oracle_target
    ?? outputOracle.outputOracleTarget,
  );
}

function outputOracleTargetKind(target) {
  return firstText(asObject(target.kind).value, target.kind, target.target_kind, target.targetKind);
}

function computeOnlyOutputTargetVerified(record) {
  const target = outputOracleTarget(record);
  return outputOracleTargetKind(target) === 'compute'
    && (target.compute_only_target_verified === true || target.computeOnlyTargetVerified === true)
    && compactStringList(target.evidence_refs ?? target.evidenceRefs).length > 0;
}

const COMPUTE_ORACLE_ARTIFACT_FIELDS = [
  ['raw_readback_bin', 'rawReadbackBin'],
  ['readback_schema_json', 'readbackSchemaJson'],
  ['checksum_before', 'checksumBefore'],
  ['checksum_after', 'checksumAfter'],
  ['deterministic_slice', 'deterministicSlice'],
  ['oracle_code_hash', 'oracleCodeHash'],
  ['rendered_card_png', 'renderedCardPng'],
  ['producer', 'producer'],
  ['timestamp_after_dispatch', 'timestampAfterDispatch'],
  ['epoch', 'epoch'],
];

const VISUAL_ORACLE_ARTIFACT_FIELDS = [
  ['before_image', 'beforeImage'],
  ['after_image', 'afterImage'],
  ['diff_image', 'diffImage'],
  ['blank_frame_rejection', 'blankFrameRejection'],
  ['same_frame_rejection', 'sameFrameRejection'],
  ['new_epoch_watermark_or_trace', 'newEpochWatermarkOrTrace', 'epoch_trace', 'epochTrace'],
  ['camera_state_hash', 'cameraStateHash'],
  ['swapchain_size', 'swapchainSize'],
  ['capture_backend', 'captureBackend'],
  ['frame_number', 'frameNumber'],
  ['timestamp_after_dispatch', 'timestampAfterDispatch'],
  ['perceptual_diff', 'perceptualDiff'],
  ['changed_pixel_ratio', 'changedPixelRatio'],
  ['visible_pixel_count', 'visiblePixelCount'],
];

function nonEmptyObject(value) {
  const object = asObject(value);
  return Object.keys(object).length > 0 ? object : null;
}

function objectFieldValue(object, keys) {
  const source = asObject(object);
  for (const key of keys) {
    if (hasOwnDeep(source, key)) return source[key];
  }
  return undefined;
}

function artifactValueRecorded(object, key) {
  if (!hasOwnDeep(object, key)) return false;
  const value = object[key];
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

function artifactHasAnyField(object, fields) {
  const source = asObject(object);
  return fields.some((keys) => keys.some((key) => artifactValueRecorded(source, key)));
}

function firstArtifactObject(candidates, fields) {
  for (const candidate of candidates) {
    const object = nonEmptyObject(candidate);
    if (object && artifactHasAnyField(object, fields)) return object;
  }
  return null;
}

function outputOracleObject(outputEvent) {
  return asObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
}

function oracleArtifactsObject(recordOracleArtifacts, outputEvent) {
  const ledgerArtifacts = asObject(recordOracleArtifacts);
  const outputArtifacts = asObject(outputEvent.oracle_artifacts ?? outputEvent.oracleArtifacts);
  const outputOracle = outputOracleObject(outputEvent);
  const outputOracleArtifacts = asObject(outputOracle.oracle_artifacts ?? outputOracle.oracleArtifacts);
  return {
    ledgerArtifacts,
    outputArtifacts,
    outputOracle,
    outputOracleArtifacts,
  };
}

function computeOracleArtifacts(recordOracleArtifacts, outputEvent) {
  const {
    ledgerArtifacts,
    outputArtifacts,
    outputOracle,
    outputOracleArtifacts,
  } = oracleArtifactsObject(recordOracleArtifacts, outputEvent);
  return firstArtifactObject([
    ledgerArtifacts.compute_oracle_artifacts,
    ledgerArtifacts.computeOracleArtifacts,
    outputArtifacts.compute_oracle_artifacts,
    outputArtifacts.computeOracleArtifacts,
    outputEvent.compute_oracle_artifacts,
    outputEvent.computeOracleArtifacts,
    outputOracle.compute_oracle_artifacts,
    outputOracle.computeOracleArtifacts,
    outputOracleArtifacts.compute_oracle_artifacts,
    outputOracleArtifacts.computeOracleArtifacts,
    ledgerArtifacts,
    outputArtifacts,
    outputOracleArtifacts,
    outputOracle,
  ], COMPUTE_ORACLE_ARTIFACT_FIELDS);
}

const ACCEPTED_COMPUTE_RAW_READBACK_SOURCES = new Set([
  'runtime_readback',
  'runtime_readback_sample',
  'runtime_raw_readback',
  'device_readback',
]);

const DIGEST_DERIVED_COMPUTE_RAW_READBACK_SOURCES = new Set([
  'runtime_checksum_digest',
  'sha256_digest_bytes',
  'checksum_digest',
  'digest_bytes',
]);

function computeRawReadbackSource(artifacts) {
  const source = artifactFieldText(
    artifacts,
    'raw_readback_source',
    'rawReadbackSource',
    'readback_source',
    'readbackSource',
    'encoding',
  );
  if (source) return source;
  const deterministicSlice = asObject(objectFieldValue(artifacts, [
    'deterministic_slice',
    'deterministicSlice',
  ]));
  return artifactFieldText(deterministicSlice, 'source');
}

function computeRawReadbackHash(artifacts) {
  return artifactFieldText(
    artifacts,
    'raw_readback_hash',
    'rawReadbackHash',
    'readback_sample_sha256',
    'readbackSampleSha256',
  );
}

function computeByteVerification(artifacts) {
  const source = asObject(artifacts);
  return asObject(
    source.raw_readback_verification
    ?? source.rawReadbackVerification
    ?? source.byte_verification
    ?? source.byteVerification,
  );
}

function computeVerifiedBool(artifacts, verification, artifactKeys, verificationKeys) {
  const source = asObject(artifacts);
  const verified = asObject(verification);
  return artifactKeys.some((key) => source[key] === true)
    || verificationKeys.some((key) => verified[key] === true);
}

function computeReadbackByteLength(artifacts, verification) {
  return artifactFieldNumber(
    { ...asObject(verification), ...asObject(artifacts) },
    'raw_readback_byte_length',
    'rawReadbackByteLength',
    'byte_length',
    'byteLength',
    'bytes',
    'size',
  );
}

function computeDeterministicSlice(artifacts) {
  return asObject(objectFieldValue(artifacts, [
    'deterministic_slice',
    'deterministicSlice',
  ]));
}

function computeDeterministicSliceHash(artifacts, slice, verification) {
  return firstText(
    asObject(artifacts).deterministic_slice_hash,
    asObject(artifacts).deterministicSliceHash,
    asObject(slice).hash,
    asObject(slice).sha256,
    asObject(slice).slice_hash,
    asObject(slice).sliceHash,
    asObject(verification).deterministic_slice_hash,
    asObject(verification).deterministicSliceHash,
  );
}

function computeSha256Digest(value) {
  return String(value ?? '').match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null;
}

function visualOracleArtifacts(recordOracleArtifacts, outputEvent) {
  const {
    ledgerArtifacts,
    outputArtifacts,
    outputOracle,
    outputOracleArtifacts,
  } = oracleArtifactsObject(recordOracleArtifacts, outputEvent);
  return firstArtifactObject([
    ledgerArtifacts.visual_oracle_artifacts,
    ledgerArtifacts.visualOracleArtifacts,
    outputArtifacts.visual_oracle_artifacts,
    outputArtifacts.visualOracleArtifacts,
    outputEvent.visual_oracle_artifacts,
    outputEvent.visualOracleArtifacts,
    outputOracle.visual_oracle_artifacts,
    outputOracle.visualOracleArtifacts,
    outputOracleArtifacts.visual_oracle_artifacts,
    outputOracleArtifacts.visualOracleArtifacts,
    ledgerArtifacts,
    outputArtifacts,
    outputOracleArtifacts,
    outputOracle,
  ], VISUAL_ORACLE_ARTIFACT_FIELDS);
}

function visualPixelVerification(artifacts) {
  const source = asObject(artifacts);
  return asObject(
    source.visual_pixel_verification
    ?? source.visualPixelVerification
    ?? source.pixel_verification
    ?? source.pixelVerification,
  );
}

function visualVerifiedBool(artifacts, verification, artifactKeys, verificationKeys) {
  const source = asObject(artifacts);
  const verified = asObject(verification);
  return artifactKeys.some((key) => source[key] === true)
    || verificationKeys.some((key) => verified[key] === true);
}

function visualArtifactHash(artifacts, verification, artifactKeys, verificationKeys) {
  const source = asObject(artifacts);
  const verified = asObject(verification);
  return firstText(...artifactKeys.map((key) => source[key]), ...verificationKeys.map((key) => verified[key]));
}

function missingArtifactFields(artifact, fields) {
  const source = asObject(artifact);
  return fields
    .filter((keys) => !keys.some((key) => artifactValueRecorded(source, key)))
    .map((keys) => keys[0]);
}

function artifactFieldText(artifact, ...keys) {
  return firstText(...keys.map((key) => asObject(artifact)[key]));
}

function artifactFieldNumber(artifact, ...keys) {
  for (const key of keys) {
    const value = asObject(artifact)[key];
    const n = finiteNumber(value);
    if (n !== null) return n;
  }
  return null;
}

function artifactFieldArray(artifact, ...keys) {
  for (const key of keys) {
    const value = asObject(artifact)[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function visualTraceCorrelates(trace, identifiers) {
  const normalizedTrace = text(trace);
  if (!normalizedTrace) return false;
  const candidates = compactStringList(identifiers);
  for (const candidate of candidates) {
    if (normalizedTrace === candidate) return true;
    if (candidate.length >= 6 && normalizedTrace.includes(candidate)) return true;
  }
  return false;
}

function modelProvenanceEntries(modelProvenance) {
  const provenance = asObject(modelProvenance);
  if (Object.keys(provenance).length === 0) return [];
  const nested = [
    ['split', provenance.split],
    ['gpu_split', provenance.gpu_split],
    ['gpuSplit', provenance.gpuSplit],
    ['last_gpu_delta', provenance.last_gpu_delta],
    ['lastGpuDelta', provenance.lastGpuDelta],
    ['gpu_delta', provenance.gpu_delta],
    ['gpuDelta', provenance.gpuDelta],
    ['delta', provenance.delta],
  ]
    .map(([role, value]) => ({ role, record: asObject(value) }))
    .filter((entry) => Object.keys(entry.record).length > 0);
  const directHasProviderFields = [
    'requested_model',
    'requestedModel',
    'provider_model_status',
    'providerModelStatus',
    'actual_model',
    'actualModel',
    'request_mode',
    'requestMode',
  ].some((key) => hasOwnDeep(provenance, key));
  return directHasProviderFields ? [{ role: 'direct', record: provenance }, ...nested] : nested;
}

function modelProvenanceRecords(modelProvenance) {
  return modelProvenanceEntries(modelProvenance).map((entry) => entry.record);
}

function modelField(record, snakeKey, camelKey) {
  return record[snakeKey] ?? record[camelKey];
}

function modelFieldRecorded(record, snakeKey, camelKey) {
  return valueRecorded(record, snakeKey) || valueRecorded(record, camelKey);
}

function modelFieldText(record, snakeKey, camelKey) {
  return firstText(modelField(record, snakeKey, camelKey));
}

function modelStatus(record) {
  return enumText(modelField(record, 'provider_model_status', 'providerModelStatus'));
}

function prefixedModelStatus(record, prefix) {
  const pascal = `${prefix[0].toUpperCase()}${prefix.slice(1)}`;
  return enumText(modelField(
    record,
    `${prefix}_provider_model_status`,
    `${prefix}ProviderModelStatus`,
  ) ?? modelField(
    record,
    `${prefix}_model_provider_status`,
    `${pascal}ModelProviderStatus`,
  ));
}

function modelStatusAccepted(status) {
  return ['available', 'deprecated', 'private_alias'].includes(status ?? '');
}

function modelHardInfraFailure(record) {
  return modelField(record, 'hard_infra_failure', 'hardInfraFailure') === true;
}

function modelFallbackUsed(record) {
  return modelField(record, 'fallback_used', 'fallbackUsed') === true;
}

function modelAliasResolvedTo(record) {
  return modelFieldText(
    record,
    'provider_model_alias_resolved_to',
    'providerModelAliasResolvedTo',
  );
}

function modelShutdownOrDeprecationDetected(record) {
  return modelField(
    record,
    'provider_shutdown_or_deprecation_detected',
    'providerShutdownOrDeprecationDetected',
  ) === true;
}

function modelRequestMode(record) {
  return modelFieldText(record, 'request_mode', 'requestMode');
}

function modelRoleIsSplit(entry) {
  return ['split', 'gpu_split', 'gpuSplit'].includes(entry.role)
    || modelRequestMode(entry.record) === 'split';
}

function modelRoleIsGpuDelta(entry) {
  return ['last_gpu_delta', 'lastGpuDelta', 'gpu_delta', 'gpuDelta', 'delta'].includes(entry.role)
    || modelRequestMode(entry.record) === 'gpu_delta';
}

function requiredModelRole(entry) {
  if (modelRoleIsSplit(entry)) return 'split';
  if (modelRoleIsGpuDelta(entry)) return 'gpu_delta';
  return null;
}

function modelMatchesRequiredModel(record, expectedModel) {
  const requestedModel = modelFieldText(record, 'requested_model', 'requestedModel');
  const actualModel = modelFieldText(record, 'actual_model', 'actualModel');
  const aliasResolvedTo = modelAliasResolvedTo(record);
  const status = modelStatus(record);
  const requestedMatches =
    requestedModel === expectedModel
    || (status === 'private_alias' && aliasResolvedTo === expectedModel);
  const actualMatches =
    actualModel === expectedModel
    || (status === 'private_alias' && aliasResolvedTo === expectedModel);
  return {
    requestedModel,
    actualModel,
    aliasResolvedTo,
    status,
    requestedMatches,
    actualMatches,
  };
}

export function normalizeGpuHmrProofLedgerRecord(input = {}) {
  const record = asObject(input);
  const artifactAfterHash = firstText(
    record.artifact_after_hash,
    record.artifactAfterHash,
    record.changed_gpu_artifact_hash,
    record.changedGpuArtifactHash,
  );
  const artifactBeforeHash = firstText(record.artifact_before_hash, record.artifactBeforeHash);
  const loaderEvent = asObject(record.loader_event ?? record.loaderEvent);
  const epochPublishEvent = asObject(record.epoch_publish_event ?? record.epochPublishEvent);
  const dispatchEvent = asObject(record.dispatch_event ?? record.dispatchEvent);
  const outputEvent = asObject(record.output_event ?? record.outputEvent);
  const retirementEvent = asObject(record.retirement_event ?? record.retirementEvent);
  const processIdentity = asObject(record.process_identity ?? record.processIdentity);
  const deviceIdentity = asObject(record.device_identity ?? record.deviceIdentity);
  const firewallEvidence = asObject(record.firewall_evidence ?? record.firewallEvidence);
  const timings = asObject(record.timings);
  const timingMetrics = asObject(
    record.timing_metrics
    ?? record.timingMetrics
    ?? timings.timing_metrics
    ?? timings.timingMetrics,
  );
  const cpuHmrUsed = firstPresent(
    [record, 'cpu_hmr_used'],
    [record, 'cpuHmrUsed'],
    [firewallEvidence, 'cpu_hmr_used'],
    [firewallEvidence, 'cpuHmrUsed'],
  );
  const fullRebuildUsed = firstPresent(
    [record, 'full_rebuild_used'],
    [record, 'fullRebuildUsed'],
    [firewallEvidence, 'full_rebuild_used'],
    [firewallEvidence, 'fullRebuildUsed'],
  );
  const processRestarted = firstPresent(
    [record, 'process_restarted'],
    [record, 'processRestarted'],
    [firewallEvidence, 'process_restarted'],
    [firewallEvidence, 'processRestarted'],
  );
  const normalized = {
    schemaVersion: record.schemaVersion ?? record.schema_version ?? GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId: firstText(record.proof_id, record.proofId),
    projectId: firstText(record.project_id, record.projectId),
    editId: firstText(record.edit_id, record.editId),
    backend: firstText(record.backend, record.gpu_backend, record.gpuBackend),
    classification: asObject(record.classification),
    contractHash: firstText(record.contract_hash, record.contractHash),
    artifactBeforeHash,
    artifactAfterHash,
    loaderEvent,
    epochPublishEvent,
    dispatchEvent,
    outputEvent,
    retirementEvent,
    processIdentity,
    deviceIdentity,
    firewallEvidence,
    cpuHmrUsed: asBool(cpuHmrUsed.value),
    cpuHmrUsedEvidencePresent: cpuHmrUsed.present,
    fullRebuildUsed: asBool(fullRebuildUsed.value),
    fullRebuildUsedEvidencePresent: fullRebuildUsed.present,
    processRestarted: asBool(processRestarted.value),
    processRestartedEvidencePresent: processRestarted.present,
    oracleArtifacts: asObject(
      record.oracle_artifacts
      ?? record.oracleArtifacts
      ?? outputEvent.oracle_artifacts
      ?? outputEvent.oracleArtifacts,
    ),
    deterministicVisualMode: asObject(
      record.deterministic_visual_mode
      ?? record.deterministicVisualMode
      ?? outputEvent.deterministic_visual_mode
      ?? outputEvent.deterministicVisualMode,
    ),
    outputOracleTarget: outputOracleTarget(record),
    metricClock: firstText(
      record.metric_clock,
      record.metricClock,
      timings.metric_clock,
      timings.metricClock,
      timingMetrics.metric_clock,
      timingMetrics.metricClock,
      asObject(timings.clock_evidence).metric_clock,
      asObject(timings.clockEvidence).metricClock,
      asObject(timingMetrics.clock_evidence).metric_clock,
      asObject(timingMetrics.clockEvidence).metricClock,
    ),
    metricScope: firstText(
      record.metric_scope,
      record.metricScope,
      timings.metric_scope,
      timings.metricScope,
      timingMetrics.metric_scope,
      timingMetrics.metricScope,
    ),
    cacheState: firstText(
      record.cache_state,
      record.cacheState,
      timings.cache_state,
      timings.cacheState,
      timingMetrics.cache_state,
      timingMetrics.cacheState,
    ),
    timings,
    timingMetrics,
    timingFieldValues: collectTimingFieldValues(timings, timingMetrics),
    modelProvenance: asObject(record.model_provenance ?? record.modelProvenance),
    evidenceRefs: compactStringList(record.evidence_refs ?? record.evidenceRefs),
  };
  normalized.proofId ??= `gpu-ledger-proof:sha256:${sha256Hex(stableJson({
    projectId: normalized.projectId,
    editId: normalized.editId,
    backend: normalized.backend,
    contractHash: normalized.contractHash,
    artifactBeforeHash: normalized.artifactBeforeHash,
    artifactAfterHash: normalized.artifactAfterHash,
    loaderEvent: normalized.loaderEvent,
    epochPublishEvent: normalized.epochPublishEvent,
    dispatchEvent: normalized.dispatchEvent,
    outputEvent: normalized.outputEvent,
    retirementEvent: normalized.retirementEvent,
    outputOracleTarget: normalized.outputOracleTarget,
    cpuHmrUsed: normalized.cpuHmrUsed,
    fullRebuildUsed: normalized.fullRebuildUsed,
    processRestarted: normalized.processRestarted,
    firewallEvidence: {
      cpuHmrUsedEvidencePresent: normalized.cpuHmrUsedEvidencePresent,
      fullRebuildUsedEvidencePresent: normalized.fullRebuildUsedEvidencePresent,
      processRestartedEvidencePresent: normalized.processRestartedEvidencePresent,
    },
  }))}`;
  return normalized;
}

function addFailure(failures, code, detail = {}) {
  failures.push({ code, ...detail });
}

export function evaluateGpuHmrProofLedger(input = {}) {
  const record = normalizeGpuHmrProofLedgerRecord(input);
  const failures = [];
  const warnings = [];
  const artifactAfterHash = record.artifactAfterHash;
  const loadedArtifactHash = eventArtifactHash(record.loaderEvent);
  const publishedArtifactHash = eventArtifactHash(record.epochPublishEvent);
  const publishedEpoch = eventEpoch(record.epochPublishEvent);
  const dispatchEpoch = eventEpoch(record.dispatchEvent);
  const dispatchId = eventId(record.dispatchEvent);
  const loaderId = eventId(record.loaderEvent);
  const epochPublishId = eventId(record.epochPublishEvent);
  const outputId = eventId(record.outputEvent);
  const retirementId = eventId(record.retirementEvent);
  const outputDispatchId = outputAfterDispatchId(record.outputEvent);
  const loaderTs = eventTimestamp(record.loaderEvent);
  const publishTs = eventTimestamp(record.epochPublishEvent);
  const dispatchTs = eventTimestamp(record.dispatchEvent);
  const outputTs = eventTimestamp(record.outputEvent);
  const retirementTs = eventTimestamp(record.retirementEvent);
  const identityPid = eventProcessId(record.processIdentity);
  const loaderPid = eventProcessId(record.loaderEvent);
  const epochPublishPid = eventProcessId(record.epochPublishEvent);
  const dispatchPid = eventProcessId(record.dispatchEvent);
  const outputPid = eventProcessId(record.outputEvent);
  const classification = asObject(record.classification);
  const projectKind = firstText(classification.project_kind, classification.projectKind);
  const editKind = firstText(classification.edit_kind, classification.editKind);
  const route = firstText(classification.route);

  if (!record.projectId) addFailure(failures, 'project_id_missing');
  if (!record.editId) addFailure(failures, 'edit_id_missing');
  if (!record.backend) {
    addFailure(failures, 'backend_missing');
  } else if (!SUPPORTED_BACKENDS.has(record.backend)) {
    addFailure(failures, 'backend_unsupported', { backend: record.backend });
  }
  if (record.evidenceRefs.length === 0) addFailure(failures, 'evidence_refs_missing');
  if (!record.metricClock) {
    addFailure(failures, 'metric_clock_missing');
  } else if (!METRIC_CLOCKS.has(record.metricClock)) {
    addFailure(failures, 'metric_clock_not_monotonic_ns', { metricClock: record.metricClock });
  }
  if (!record.metricScope) {
    addFailure(failures, 'metric_scope_missing');
  } else if (!METRIC_SCOPES.has(record.metricScope)) {
    addFailure(failures, 'metric_scope_unsupported', { metricScope: record.metricScope });
  }
  if (!record.cacheState) {
    addFailure(failures, 'cache_state_missing');
  } else if (!CACHE_STATES.has(record.cacheState)) {
    addFailure(failures, 'cache_state_unsupported', { cacheState: record.cacheState });
  }
  if (
    (!record.timings || Object.keys(record.timings).length === 0)
    && (!record.timingMetrics || Object.keys(record.timingMetrics).length === 0)
  ) {
    addFailure(failures, 'timings_missing');
  }
  for (const [snakeKey] of REQUIRED_TIMING_FIELDS) {
    if (record.timingFieldValues[snakeKey] === null) {
      addFailure(failures, `timing_${snakeKey}_missing`);
    }
  }

  if (!projectKind) {
    addFailure(failures, 'classification_project_kind_missing');
  } else if (!GPU_PROJECT_KINDS.has(projectKind)) {
    addFailure(failures, 'classification_project_kind_not_gpu_hmr', { projectKind });
  }
  if (!editKind) {
    addFailure(failures, 'classification_edit_kind_missing');
  } else if (!GPU_ARTIFACT_EDIT_KINDS.has(editKind)) {
    addFailure(failures, 'classification_edit_kind_not_gpu_artifact', { editKind });
  }
  if (!route) addFailure(failures, 'classification_route_missing');
  if (projectKind === 'cpu_project') addFailure(failures, 'classification_cpu_project');
  if (editKind === 'host_only') addFailure(failures, 'classification_host_only_edit');
  if (route && route !== 'gpu_hmr') addFailure(failures, 'classification_route_not_gpu_hmr', { route });
  if (!record.cpuHmrUsedEvidencePresent) addFailure(failures, 'cpu_hmr_absence_evidence_missing');
  if (!record.fullRebuildUsedEvidencePresent) addFailure(failures, 'full_rebuild_absence_evidence_missing');
  if (!record.processRestartedEvidencePresent) addFailure(failures, 'process_restart_absence_evidence_missing');
  if (record.cpuHmrUsed) addFailure(failures, 'cpu_hmr_used');
  if (record.fullRebuildUsed) addFailure(failures, 'full_rebuild_used');
  if (record.processRestarted) addFailure(failures, 'process_restarted');
  if (!record.contractHash) addFailure(failures, 'contract_hash_missing');
  if (!record.artifactBeforeHash) addFailure(failures, 'artifact_before_hash_missing');
  if (!artifactAfterHash) addFailure(failures, 'artifact_after_hash_missing');
  if (record.artifactBeforeHash && artifactAfterHash && record.artifactBeforeHash === artifactAfterHash) {
    addFailure(failures, 'artifact_hash_unchanged');
  }
  if (!loadedArtifactHash) {
    addFailure(failures, 'loader_artifact_hash_missing');
  } else if (artifactAfterHash && loadedArtifactHash !== artifactAfterHash) {
    addFailure(failures, 'loader_artifact_hash_mismatch', {
      expected: artifactAfterHash,
      actual: loadedArtifactHash,
    });
  }
  if (!loaderId) addFailure(failures, 'loader_event_id_missing');
  if (loaderTs === null) addFailure(failures, 'loader_timestamp_missing');
  if (!publishedArtifactHash) {
    addFailure(failures, 'epoch_publish_artifact_hash_missing');
  } else if (artifactAfterHash && publishedArtifactHash !== artifactAfterHash) {
    addFailure(failures, 'epoch_publish_artifact_hash_mismatch', {
      expected: artifactAfterHash,
      actual: publishedArtifactHash,
    });
  }
  if (!epochPublishId) addFailure(failures, 'epoch_publish_event_id_missing');
  if (!publishedEpoch) addFailure(failures, 'epoch_publish_id_missing');
  if (publishTs === null) addFailure(failures, 'epoch_publish_timestamp_missing');
  if (loaderTs !== null && publishTs !== null && publishTs < loaderTs) {
    addFailure(failures, 'epoch_publish_precedes_loader', {
      loaderTimestamp: loaderTs,
      publishTimestamp: publishTs,
    });
  }
  if (!dispatchEpoch) {
    addFailure(failures, 'dispatch_epoch_missing');
  } else if (publishedEpoch && dispatchEpoch !== publishedEpoch) {
    addFailure(failures, 'dispatch_epoch_mismatch', {
      expected: publishedEpoch,
      actual: dispatchEpoch,
    });
  }
  if (!dispatchId) addFailure(failures, 'dispatch_id_missing');
  const dispatchArtifactHash = eventArtifactHash(record.dispatchEvent);
  if (!dispatchArtifactHash) {
    addFailure(failures, 'dispatch_artifact_hash_missing');
  } else if (artifactAfterHash && dispatchArtifactHash !== artifactAfterHash) {
    addFailure(failures, 'dispatch_artifact_hash_mismatch', {
      expected: artifactAfterHash,
      actual: dispatchArtifactHash,
    });
  }
  if (dispatchTs === null) addFailure(failures, 'dispatch_timestamp_missing');
  if (publishTs !== null && dispatchTs !== null && dispatchTs < publishTs) {
    addFailure(failures, 'dispatch_precedes_epoch_publish', {
      publishTimestamp: publishTs,
      dispatchTimestamp: dispatchTs,
    });
  }
  if (!outputDispatchId) {
    addFailure(failures, 'output_after_dispatch_id_missing');
  } else if (dispatchId && outputDispatchId !== dispatchId) {
    addFailure(failures, 'output_after_dispatch_id_mismatch', {
      expected: dispatchId,
      actual: outputDispatchId,
    });
  }
  if (!outputId) addFailure(failures, 'output_event_id_missing');
  if (record.outputEvent.passed !== true) addFailure(failures, 'output_oracle_not_passed');
  const outputArtifactHash = eventArtifactHash(record.outputEvent);
  if (!outputArtifactHash) {
    addFailure(failures, 'output_artifact_hash_missing');
  } else if (artifactAfterHash && outputArtifactHash !== artifactAfterHash) {
    addFailure(failures, 'output_artifact_hash_mismatch', {
      expected: artifactAfterHash,
      actual: outputArtifactHash,
    });
  }
  const outputEpoch = eventEpoch(record.outputEvent);
  if (!outputEpoch) {
    addFailure(failures, 'output_epoch_missing');
  } else if (publishedEpoch && outputEpoch !== publishedEpoch) {
    addFailure(failures, 'output_epoch_mismatch', {
      expected: publishedEpoch,
      actual: outputEpoch,
    });
  }
  if (outputTs === null) addFailure(failures, 'output_timestamp_missing');
  if (dispatchTs !== null && outputTs !== null && outputTs < dispatchTs) {
    addFailure(failures, 'output_precedes_dispatch', {
      dispatchTimestamp: dispatchTs,
      outputTimestamp: outputTs,
    });
  }
  if (!identityPid) addFailure(failures, 'process_identity_missing');
  if (!loaderPid) addFailure(failures, 'loader_process_identity_missing');
  if (!epochPublishPid) addFailure(failures, 'epoch_publish_process_identity_missing');
  if (!dispatchPid) addFailure(failures, 'dispatch_process_identity_missing');
  if (!outputPid) addFailure(failures, 'output_process_identity_missing');
  if (identityPid && loaderPid && loaderPid !== identityPid) {
    addFailure(failures, 'loader_process_identity_mismatch', {
      expected: identityPid,
      actual: loaderPid,
    });
  }
  if (identityPid && epochPublishPid && epochPublishPid !== identityPid) {
    addFailure(failures, 'epoch_publish_process_identity_mismatch', {
      expected: identityPid,
      actual: epochPublishPid,
    });
  }
  if (identityPid && dispatchPid && dispatchPid !== identityPid) {
    addFailure(failures, 'dispatch_process_identity_mismatch', {
      expected: identityPid,
      actual: dispatchPid,
    });
  }
  if (identityPid && outputPid && outputPid !== identityPid) {
    addFailure(failures, 'output_process_identity_mismatch', {
      expected: identityPid,
      actual: outputPid,
    });
  }
  if (!record.deviceIdentity || Object.keys(record.deviceIdentity).length === 0) {
    addFailure(failures, 'device_identity_missing');
  }
  if (!record.retirementEvent || Object.keys(record.retirementEvent).length === 0) {
    addFailure(failures, 'retirement_event_missing');
  } else {
    if (!retirementId) addFailure(failures, 'retirement_event_id_missing');
    if (retirementTs === null) addFailure(failures, 'retirement_timestamp_missing');
    if (outputTs !== null && retirementTs !== null && retirementTs < outputTs) {
      addFailure(failures, 'retirement_precedes_output', {
        outputTimestamp: outputTs,
        retirementTimestamp: retirementTs,
      });
    }
    const retirementStatus = firstText(
      record.retirementEvent.status,
      record.retirementEvent.proof,
      record.retirementEvent.retirement_proof,
      record.retirementEvent.retirementProof,
    );
    if (!retirementStatus) addFailure(failures, 'retirement_proof_missing');
  }
  const visualArtifacts = visualOracleArtifacts(record.oracleArtifacts, record.outputEvent);
  const visualOutput = isVisualOutput(record.outputEvent) || visualArtifacts;
  const visualBackend = VISUAL_OR_ENGINE_BACKENDS.has(record.backend);
  const computeOnlyTargetVerified = computeOnlyOutputTargetVerified(record);
  const oracleTargetKind = outputOracleTargetKind(record.outputOracleTarget);
  if (visualBackend && !visualOutput && !computeOnlyTargetVerified) {
    addFailure(failures, 'visual_backend_requires_visual_oracle', { backend: record.backend });
  }
  if (visualBackend && oracleTargetKind === 'compute' && !computeOnlyTargetVerified) {
    addFailure(failures, 'visual_backend_compute_target_unverified', { backend: record.backend });
  }
  if (visualOutput) {
    const artifacts = visualArtifacts;
    if (!artifacts) {
      addFailure(failures, 'visual_oracle_artifacts_missing');
    } else {
      const missingFields = missingArtifactFields(artifacts, VISUAL_ORACLE_ARTIFACT_FIELDS);
      if (missingFields.length > 0) {
        addFailure(failures, 'visual_oracle_artifacts_incomplete', { missingFields });
      }
      if (objectFieldValue(artifacts, ['blank_frame_rejection', 'blankFrameRejection']) !== true) {
        addFailure(failures, 'visual_blank_frame_rejection_not_proven');
      }
      if (objectFieldValue(artifacts, ['same_frame_rejection', 'sameFrameRejection']) !== true) {
        addFailure(failures, 'visual_same_frame_rejection_not_proven');
      }
      const beforeImage = artifactFieldText(artifacts, 'before_image', 'beforeImage');
      const afterImage = artifactFieldText(artifacts, 'after_image', 'afterImage');
      const diffImage = artifactFieldText(artifacts, 'diff_image', 'diffImage');
      if (beforeImage && afterImage && beforeImage === afterImage) {
        addFailure(failures, 'visual_before_after_same_artifact');
      }
      if (diffImage && (diffImage === beforeImage || diffImage === afterImage)) {
        addFailure(failures, 'visual_diff_artifact_not_independent');
      }
      const pixelVerification = visualPixelVerification(artifacts);
      const pixelMetricsVerified = visualVerifiedBool(
        artifacts,
        pixelVerification,
        ['pixel_metrics_verified', 'pixelMetricsVerified'],
        ['metrics_verified', 'metricsVerified', 'pixel_metrics_verified', 'pixelMetricsVerified'],
      );
      if (!pixelMetricsVerified) {
        addFailure(failures, 'visual_pixel_metrics_unverified');
      }
      const beforeHash = visualArtifactHash(
        artifacts,
        pixelVerification,
        ['before_image_hash', 'beforeImageHash'],
        ['before_image_hash', 'beforeImageHash'],
      );
      const afterHash = visualArtifactHash(
        artifacts,
        pixelVerification,
        ['after_image_hash', 'afterImageHash'],
        ['after_image_hash', 'afterImageHash'],
      );
      const diffHash = visualArtifactHash(
        artifacts,
        pixelVerification,
        ['diff_image_hash', 'diffImageHash'],
        ['diff_image_hash', 'diffImageHash'],
      );
      if (!beforeHash) addFailure(failures, 'visual_before_image_hash_missing');
      else if (!computeSha256Digest(beforeHash)) addFailure(failures, 'visual_before_image_hash_invalid');
      if (!afterHash) addFailure(failures, 'visual_after_image_hash_missing');
      else if (!computeSha256Digest(afterHash)) addFailure(failures, 'visual_after_image_hash_invalid');
      if (!diffHash) addFailure(failures, 'visual_diff_image_hash_missing');
      else if (!computeSha256Digest(diffHash)) addFailure(failures, 'visual_diff_image_hash_invalid');
      if (beforeHash && afterHash && beforeHash === afterHash) {
        addFailure(failures, 'visual_before_after_same_frame_hash');
      }
      if (!visualVerifiedBool(
        artifacts,
        pixelVerification,
        ['before_image_hash_verified', 'beforeImageHashVerified'],
        ['before_image_hash_verified', 'beforeImageHashVerified'],
      )) {
        addFailure(failures, 'visual_before_image_hash_unverified');
      }
      if (!visualVerifiedBool(
        artifacts,
        pixelVerification,
        ['after_image_hash_verified', 'afterImageHashVerified'],
        ['after_image_hash_verified', 'afterImageHashVerified'],
      )) {
        addFailure(failures, 'visual_after_image_hash_unverified');
      }
      if (!visualVerifiedBool(
        artifacts,
        pixelVerification,
        ['diff_image_hash_verified', 'diffImageHashVerified'],
        ['diff_image_hash_verified', 'diffImageHashVerified'],
      )) {
        addFailure(failures, 'visual_diff_image_hash_unverified');
      }
      const changedPixelRatio = artifactFieldNumber(
        artifacts,
        'changed_pixel_ratio',
        'changedPixelRatio',
      );
      if (changedPixelRatio !== null && changedPixelRatio <= 0) {
        addFailure(failures, 'visual_changed_pixel_ratio_zero');
      }
      const perceptualDiff = artifactFieldNumber(artifacts, 'perceptual_diff', 'perceptualDiff');
      if (perceptualDiff !== null && perceptualDiff <= 0) {
        addFailure(failures, 'visual_perceptual_diff_zero');
      }
      const visiblePixelCount = artifactFieldNumber(
        artifacts,
        'visible_pixel_count',
        'visiblePixelCount',
      );
      if (visiblePixelCount !== null && visiblePixelCount <= 0) {
        addFailure(failures, 'visual_visible_pixel_count_zero');
      }
      const swapchainSize = artifactFieldArray(artifacts, 'swapchain_size', 'swapchainSize');
      if (
        swapchainSize.length !== 2
        || !swapchainSize.every((value) => Number.isFinite(Number(value)) && Number(value) > 0)
      ) {
        addFailure(failures, 'visual_swapchain_size_invalid');
      }
      const visualTimestamp = artifactFieldNumber(
        artifacts,
        'timestamp_after_dispatch',
        'timestampAfterDispatch',
      );
      if (dispatchTs !== null && visualTimestamp !== null && visualTimestamp < dispatchTs) {
        addFailure(failures, 'visual_artifact_precedes_dispatch');
      }
      const visualTrace = objectFieldValue(artifacts, [
        'new_epoch_watermark_or_trace',
        'newEpochWatermarkOrTrace',
        'epoch_trace',
        'epochTrace',
      ]);
      if (!visualTraceCorrelates(visualTrace, [
        publishedEpoch,
        dispatchEpoch,
        artifactAfterHash,
        dispatchId,
      ])) {
        addFailure(failures, 'visual_epoch_trace_not_correlated');
      }
    }
    const deterministicVisualModeEvaluation =
      evaluateGpuHmrDeterministicVisualMode(record.deterministicVisualMode);
    if (deterministicVisualModeEvaluation.accepted !== true) {
      addFailure(failures, 'visual_output_without_deterministic_mode', {
        failedGates: deterministicVisualModeEvaluation.failedGates,
      });
      for (const gate of deterministicVisualModeEvaluation.failedGates) {
        addFailure(failures, gate.code ?? 'deterministic_visual_mode_gate_failed');
      }
    }
  } else {
    const artifacts = computeOracleArtifacts(record.oracleArtifacts, record.outputEvent);
    if (!artifacts) {
      addFailure(failures, 'compute_oracle_artifacts_missing');
    } else {
      const missingFields = missingArtifactFields(artifacts, COMPUTE_ORACLE_ARTIFACT_FIELDS);
      if (missingFields.length > 0) {
        addFailure(failures, 'compute_oracle_artifacts_incomplete', { missingFields });
      }
      const checksumBefore = artifactFieldText(artifacts, 'checksum_before', 'checksumBefore');
      const checksumAfter = artifactFieldText(artifacts, 'checksum_after', 'checksumAfter');
      const rawReadbackSource = String(computeRawReadbackSource(artifacts) ?? '').trim().toLowerCase();
      const rawReadbackHash = computeRawReadbackHash(artifacts);
      const byteVerification = computeByteVerification(artifacts);
      const rawReadbackByteLength = computeReadbackByteLength(artifacts, byteVerification);
      const rawReadbackHashVerified = computeVerifiedBool(
        artifacts,
        byteVerification,
        ['raw_readback_hash_verified', 'rawReadbackHashVerified'],
        ['hash_verified', 'hashVerified', 'raw_readback_hash_verified', 'rawReadbackHashVerified'],
      );
      const deterministicSlice = computeDeterministicSlice(artifacts);
      const deterministicSliceOffset = artifactFieldNumber(deterministicSlice, 'offset', 'byte_offset', 'byteOffset');
      const deterministicSliceLength = artifactFieldNumber(deterministicSlice, 'length', 'byte_length', 'byteLength');
      const deterministicSliceHash = computeDeterministicSliceHash(artifacts, deterministicSlice, byteVerification);
      const deterministicSliceHashVerified = computeVerifiedBool(
        artifacts,
        byteVerification,
        ['deterministic_slice_hash_verified', 'deterministicSliceHashVerified'],
        ['deterministic_slice_hash_verified', 'deterministicSliceHashVerified', 'slice_hash_verified', 'sliceHashVerified'],
      );
      if (!rawReadbackHash) {
        addFailure(failures, 'compute_oracle_raw_readback_unproven');
      } else if (!computeSha256Digest(rawReadbackHash)) {
        addFailure(failures, 'compute_oracle_raw_readback_hash_invalid');
      }
      if (!rawReadbackHashVerified) {
        addFailure(failures, 'compute_oracle_raw_readback_hash_unverified');
      }
      if (rawReadbackByteLength === null || rawReadbackByteLength <= 0) {
        addFailure(failures, 'compute_oracle_raw_readback_bytes_missing');
      }
      if (deterministicSliceOffset === null || deterministicSliceLength === null || deterministicSliceLength <= 0) {
        addFailure(failures, 'compute_oracle_deterministic_slice_bounds_missing');
      } else if (
        rawReadbackByteLength !== null
        && rawReadbackByteLength > 0
        && deterministicSliceOffset + deterministicSliceLength > rawReadbackByteLength
      ) {
        addFailure(failures, 'compute_oracle_deterministic_slice_out_of_bounds');
      }
      if (!deterministicSliceHash) {
        addFailure(failures, 'compute_oracle_deterministic_slice_hash_missing');
      } else if (!computeSha256Digest(deterministicSliceHash)) {
        addFailure(failures, 'compute_oracle_deterministic_slice_hash_invalid');
      }
      if (!deterministicSliceHashVerified) {
        addFailure(failures, 'compute_oracle_deterministic_slice_hash_unverified');
      }
      if (
        DIGEST_DERIVED_COMPUTE_RAW_READBACK_SOURCES.has(rawReadbackSource)
        || /digest/.test(rawReadbackSource)
      ) {
        addFailure(failures, 'compute_oracle_raw_readback_digest_derived');
      } else if (!ACCEPTED_COMPUTE_RAW_READBACK_SOURCES.has(rawReadbackSource)) {
        addFailure(failures, 'compute_oracle_raw_readback_source_unaccepted');
      }
      const outputChangeExpected = objectFieldValue(artifacts, [
        'output_change_expected',
        'outputChangeExpected',
        'expected_output_change',
        'expectedOutputChange',
      ]) === true;
      if (outputChangeExpected && checksumBefore && checksumAfter && checksumBefore === checksumAfter) {
        addFailure(failures, 'compute_oracle_checksum_unchanged');
      }
    }
  }
  const modelEntries = modelProvenanceEntries(record.modelProvenance);
  const modelRecords = modelEntries.map((entry) => entry.record);
  if (modelEntries.length === 0) {
    addFailure(failures, 'model_provenance_missing');
  }
  if (!modelEntries.some(modelRoleIsSplit)) {
    addFailure(failures, 'model_provenance_split_missing');
  }
  if (!modelEntries.some(modelRoleIsGpuDelta)) {
    addFailure(failures, 'model_provenance_gpu_delta_missing');
  }
  for (const [index, model] of modelRecords.entries()) {
    const prefix = `model_provenance_${index}`;
    for (const [snakeKey, camelKey, code] of [
      ['provider', 'provider', 'provider_missing'],
      ['requested_model', 'requestedModel', 'requested_model_missing'],
      ['provider_model_status', 'providerModelStatus', 'provider_model_status_missing'],
      ['provider_model_alias_resolved_to', 'providerModelAliasResolvedTo', 'provider_model_alias_resolved_to_missing'],
      ['provider_shutdown_or_deprecation_detected', 'providerShutdownOrDeprecationDetected',
        'provider_shutdown_or_deprecation_detected_missing'],
      ['model_availability_checked_at', 'modelAvailabilityCheckedAt', 'model_availability_checked_at_missing'],
      ['model_availability_source', 'modelAvailabilitySource', 'model_availability_source_missing'],
      ['model_availability_basis', 'modelAvailabilityBasis', 'model_availability_basis_missing'],
      ['model_availability_check_time_ms', 'modelAvailabilityCheckTimeMs',
        'model_availability_check_time_ms_missing'],
      ['actual_model', 'actualModel', 'actual_model_missing'],
      ['fallback_model', 'fallbackModel', 'fallback_model_missing'],
      ['fallback_used', 'fallbackUsed', 'fallback_used_missing'],
      ['request_mode', 'requestMode', 'request_mode_missing'],
      ['hard_infra_failure', 'hardInfraFailure', 'hard_infra_failure_missing'],
    ]) {
      if (!modelFieldRecorded(model, snakeKey, camelKey)) {
        addFailure(failures, code, { record: prefix });
      }
    }
    const status = modelStatus(model);
    if (status === 'shutdown') {
      addFailure(failures, 'model_provider_status_shutdown', {
        record: prefix,
        requested_model: modelFieldText(model, 'requested_model', 'requestedModel'),
      });
    } else if (!modelStatusAccepted(status)) {
      addFailure(failures, 'model_provider_status_not_accepted', {
        record: prefix,
        provider_model_status: status,
      });
    }
    const availabilitySource = modelFieldText(model, 'model_availability_source', 'modelAvailabilitySource');
    if (!availabilitySource || availabilitySource === 'provider_not_checked') {
      addFailure(failures, 'model_availability_source_untrusted', {
        record: prefix,
        model_availability_source: availabilitySource,
      });
    }
    const availabilityBasis = modelFieldText(model, 'model_availability_basis', 'modelAvailabilityBasis');
    if (!MODEL_AVAILABILITY_BASES.has(availabilityBasis ?? '')) {
      addFailure(failures, 'model_availability_basis_not_accepted', {
        record: prefix,
        model_availability_basis: availabilityBasis,
      });
    }
    if (
      status === 'private_alias'
      && !['private_alias_env', 'live_model_list_registry_override'].includes(availabilityBasis ?? '')
    ) {
      addFailure(failures, 'model_private_alias_basis_unproven', {
        record: prefix,
        model_availability_basis: availabilityBasis,
      });
    }
    const role = requiredModelRole(modelEntries[index]);
    if (role) {
      const provider = modelFieldText(model, 'provider', 'provider');
      if (provider !== REQUIRED_MODEL_PROVIDER) {
        addFailure(failures, 'model_provider_not_allowed', {
          record: prefix,
          request_mode: role,
          provider,
          expected_provider: REQUIRED_MODEL_PROVIDER,
        });
      }
      const expectedModel = REQUIRED_MODEL_BY_ROLE[role];
      const modelMatch = modelMatchesRequiredModel(model, expectedModel);
      if (modelMatch.status === 'private_alias' && !modelMatch.aliasResolvedTo) {
        addFailure(failures, 'model_private_alias_unresolved', {
          record: prefix,
          request_mode: role,
          expected_model: expectedModel,
        });
      }
      if (!modelMatch.requestedMatches) {
        addFailure(failures, 'model_requested_model_unexpected', {
          record: prefix,
          request_mode: role,
          requested_model: modelMatch.requestedModel,
          provider_model_alias_resolved_to: modelMatch.aliasResolvedTo,
          expected_model: expectedModel,
        });
      }
      if (!modelMatch.actualMatches) {
        addFailure(failures, 'model_actual_model_unexpected', {
          record: prefix,
          request_mode: role,
          actual_model: modelMatch.actualModel,
          provider_model_alias_resolved_to: modelMatch.aliasResolvedTo,
          expected_model: expectedModel,
        });
      }
    }
    if (modelHardInfraFailure(model)) {
      addFailure(failures, 'model_hard_infra_failure', { record: prefix });
    }
    if (modelRoleIsGpuDelta(modelEntries[index]) && modelFallbackUsed(model)) {
      addFailure(failures, 'gpu_delta_model_fallback_used', { record: prefix });
    }
    if (modelFallbackUsed(model)) {
      for (const [snakeKey, camelKey, code] of [
        ['actual_provider_model_status', 'actualProviderModelStatus', 'actual_provider_model_status_missing'],
        ['actual_model_availability_checked_at', 'actualModelAvailabilityCheckedAt',
          'actual_model_availability_checked_at_missing'],
        ['actual_model_availability_basis', 'actualModelAvailabilityBasis',
          'actual_model_availability_basis_missing'],
        ['fallback_provider_model_status', 'fallbackProviderModelStatus', 'fallback_provider_model_status_missing'],
        ['fallback_model_availability_checked_at', 'fallbackModelAvailabilityCheckedAt',
          'fallback_model_availability_checked_at_missing'],
        ['fallback_model_availability_basis', 'fallbackModelAvailabilityBasis',
          'fallback_model_availability_basis_missing'],
      ]) {
        if (!modelFieldRecorded(model, snakeKey, camelKey)) {
          addFailure(failures, code, { record: prefix });
        }
      }
      const actualStatus = prefixedModelStatus(model, 'actual');
      if (actualStatus === 'shutdown') {
        addFailure(failures, 'actual_model_provider_status_shutdown', { record: prefix });
      } else if (!modelStatusAccepted(actualStatus)) {
        addFailure(failures, 'actual_provider_model_status_not_accepted', {
          record: prefix,
          provider_model_status: actualStatus,
        });
      }
      const fallbackStatus = prefixedModelStatus(model, 'fallback');
      if (fallbackStatus === 'shutdown') {
        addFailure(failures, 'fallback_model_provider_status_shutdown', { record: prefix });
      } else if (!modelStatusAccepted(fallbackStatus)) {
        addFailure(failures, 'fallback_provider_model_status_not_accepted', {
          record: prefix,
          provider_model_status: fallbackStatus,
        });
      }
    }
    if (
      modelStatus(model) === 'deprecated'
      && !modelShutdownOrDeprecationDetected(model)
    ) {
      addFailure(failures, 'model_deprecation_not_recorded', { record: prefix });
    }
  }
  return {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId: record.proofId,
    gpuHmrSuccess: failures.length === 0,
    failedInvariants: failures,
    warnings,
    record,
    invariantSummary: {
      cpuHmrUsed: record.cpuHmrUsed,
      cpuHmrUsedEvidencePresent: record.cpuHmrUsedEvidencePresent,
      fullRebuildUsed: record.fullRebuildUsed,
      fullRebuildUsedEvidencePresent: record.fullRebuildUsedEvidencePresent,
      processRestarted: record.processRestarted,
      processRestartedEvidencePresent: record.processRestartedEvidencePresent,
      artifactAfterHash,
      loadedArtifactHash,
      publishedArtifactHash,
      publishedEpoch,
      dispatchEpoch,
      dispatchId,
      dispatchArtifactHash,
      outputDispatchId,
      outputPassed: record.outputEvent.passed === true,
      metricClock: record.metricClock,
      metricScope: record.metricScope,
      cacheState: record.cacheState,
    },
  };
}

export function buildGpuHmrProofLedger(input = {}) {
  const record = normalizeGpuHmrProofLedgerRecord(input);
  const query = evaluateGpuHmrProofLedger(record);
  return {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId: record.proofId,
    records: [record],
    query,
    gpuHmrSuccess: query.gpuHmrSuccess,
    gpu_hmr_success: query.gpuHmrSuccess,
  };
}

export function queryGpuHmrLedgerInvariants(input = {}) {
  const ledger = asObject(input);
  const records = Array.isArray(ledger.records) ? ledger.records : null;
  const recomputed = records && records.length > 0
    ? evaluateGpuHmrProofLedger(records[records.length - 1])
    : evaluateGpuHmrProofLedger(input);
  const consistencyFailures = [];
  const topLevelProofId = firstText(ledger.proofId, ledger.proof_id);
  if (records && records.length > 0 && topLevelProofId && topLevelProofId !== recomputed.proofId) {
    consistencyFailures.push({
      code: 'ledger_proof_id_mismatch',
      suppliedProofId: topLevelProofId,
      recomputedProofId: recomputed.proofId,
    });
  }
  const topLevelSuccess = firstPresent(
    [ledger, 'gpuHmrSuccess'],
    [ledger, 'gpu_hmr_success'],
  );
  if (
    records
    && records.length > 0
    && topLevelSuccess.present
    && topLevelSuccess.value !== recomputed.gpuHmrSuccess
  ) {
    consistencyFailures.push({
      code: 'ledger_success_flag_mismatch',
      suppliedGpuHmrSuccess: topLevelSuccess.value,
      recomputedGpuHmrSuccess: recomputed.gpuHmrSuccess,
    });
  }
  const suppliedQuery = asObject(ledger.query);
  if (suppliedQuery.schemaVersion === GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION) {
    const suppliedFailures = compactStringList(asObject(suppliedQuery).failedInvariants?.map?.((failure) => failure?.code));
    const recomputedFailures = compactStringList(recomputed.failedInvariants.map((failure) => failure.code));
    const suppliedConsistent =
      suppliedQuery.gpuHmrSuccess === recomputed.gpuHmrSuccess
      && firstText(suppliedQuery.proofId, suppliedQuery.proof_id) === recomputed.proofId
      && stableJson(suppliedFailures) === stableJson(recomputedFailures);
    if (!suppliedConsistent) {
      return {
        ...recomputed,
        gpuHmrSuccess: false,
        failedInvariants: [
          ...recomputed.failedInvariants,
          {
            code: 'supplied_ledger_query_mismatch',
            suppliedGpuHmrSuccess: suppliedQuery.gpuHmrSuccess,
            recomputedGpuHmrSuccess: recomputed.gpuHmrSuccess,
          },
          ...consistencyFailures,
        ],
      };
    }
  } else if (Object.keys(suppliedQuery).length > 0) {
    consistencyFailures.push({
      code: 'supplied_ledger_query_schema_mismatch',
      suppliedSchemaVersion: suppliedQuery.schemaVersion ?? suppliedQuery.schema_version ?? null,
    });
  }
  if (consistencyFailures.length > 0) {
    return {
      ...recomputed,
      gpuHmrSuccess: false,
      failedInvariants: [
        ...recomputed.failedInvariants,
        ...consistencyFailures,
      ],
    };
  }
  return recomputed;
}

export function assertGpuHmrProofLedgerSuccess(input = {}) {
  const result = queryGpuHmrLedgerInvariants(input);
  if (!result.gpuHmrSuccess) {
    const codes = result.failedInvariants.map((failure) => failure.code).join(',');
    throw new Error(`GPU HMR proof ledger rejected record: ${codes}`);
  }
  return result;
}
