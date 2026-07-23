import { createHash } from 'node:crypto';
import { evaluateGpuHmrDeterministicVisualMode } from './gpu-hmr-visual-evidence.mjs';

export const GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION = 'synthi.gpu.hmr.proof_ledger.v1';
export const GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE =
  'synthi.gpu_hmr.proof_ledger.portable.v2';
export const GPU_HMR_VISUAL_CAPTURE_RUNTIME_BINDING_SCHEMA_VERSION =
  'synthi.gpu_hmr.visual_capture_runtime_binding.v1';
export const GPU_HMR_VISUAL_CAPTURE_RUNTIME_BINDING_AUTHORITY =
  'visual_capture_runtime_correlation_only_not_gpu_hmr_success';
export const GPU_HMR_FRAME_GATE_RUNTIME_BINDING_SCHEMA_VERSION =
  'synthi.gpu_hmr.frame_gate_runtime_binding.v1';
export const GPU_HMR_FRAME_GATE_RUNTIME_BINDING_AUTHORITY =
  'validated_runtime_tuple_for_visual_capture_gate_only_not_gpu_hmr_success';

const GPU_PROJECT_KINDS = new Set(['gpu_project', 'mixed_project']);
const GPU_ARTIFACT_EDIT_KINDS = new Set(['gpu_artifact_edit']);
const METRIC_CLOCKS = new Set(['monotonic_ns']);
const METRIC_SCOPES = new Set(['cold', 'warm', 'hot_delta_1', 'hot_delta_2']);
const CACHE_STATES = new Set(['clean', 'compiler_cache_warm', 'pipeline_cache_warm']);
const SUCCESSFUL_RETIREMENT_PROOFS = new Set([
  'stream_event_proven',
  'queue_idle_proven',
  'frame_boundary_proven',
  'no_retirement_required',
]);
const SUCCESSFUL_RETIREMENT_RESULTS = new Set(['retired_after_quiescent']);
const NORMALIZED_RECORD_STATE = new WeakMap();
const MODEL_AVAILABILITY_BASES = new Set([
  'static_registry',
  'static_registry+live_model_list',
  'live_model_list',
  'live_model_list_registry_override',
  'private_alias_env',
]);
export const DEFAULT_GPU_HMR_MODEL_POLICY = Object.freeze({
  roles: Object.freeze({
    split: Object.freeze({ provider: 'google_gemini', model: 'gemini-3.5-flash' }),
    gpu_delta: Object.freeze({ provider: 'google_gemini', model: 'gemini-3.1-flash-lite' }),
  }),
  providerAliases: Object.freeze({
    google_gemini: Object.freeze(['gemini', 'gemini_api', 'google_gemini']),
  }),
});
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

function objectAliasMismatch(object, leftKey, rightKey) {
  return hasOwn(object, leftKey)
    && hasOwn(object, rightKey)
    && stableJson(object[leftKey]) !== stableJson(object[rightKey]);
}

function aliasGroupValues(object, keys) {
  const source = asObject(object);
  return keys
    .filter((key) => hasOwn(source, key))
    .map((key) => ({ key, value: source[key], stableValue: stableJson(source[key]) }));
}

function aliasGroupMismatch(object, keys) {
  return new Set(aliasGroupValues(object, keys).map(({ stableValue }) => stableValue)).size > 1;
}

function aliasGroupPresent(object, keys) {
  return aliasGroupValues(object, keys).length > 0;
}

function aliasGroupFirstValue(object, keys) {
  return aliasGroupValues(object, keys)[0]?.value;
}

function deepSnakeCamelAliasMismatch(value) {
  if (Array.isArray(value)) return value.some(deepSnakeCamelAliasMismatch);
  if (!value || typeof value !== 'object') return false;
  for (const key of Object.keys(value)) {
    if (key.includes('_')) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      if (
        camelKey !== key
        && hasOwn(value, camelKey)
        && stableJson(value[key]) !== stableJson(value[camelKey])
      ) {
        return true;
      }
    }
    if (deepSnakeCamelAliasMismatch(value[key])) return true;
  }
  return false;
}

function eventFieldAliasMismatch(event, mode = 'standard') {
  const eventIdAliases = ['id', 'event_id', 'eventId', 'proof_id', 'proofId'];
  if (mode === 'dispatch') eventIdAliases.push('dispatch_id', 'dispatchId');
  const aliasGroups = [
    eventIdAliases,
    ['event', 'event_kind', 'eventKind', 'kind'],
    ['epoch', 'epoch_id', 'epochId', 'generation'],
    [
      'artifact_hash', 'artifactHash', 'artifact_id', 'artifactId',
      'loaded_artifact_hash', 'loadedArtifactHash', 'loaded_artifact_id',
      'loadedArtifactId', 'published_artifact_hash', 'publishedArtifactHash',
      'published_artifact_id', 'publishedArtifactId', 'runtime_artifact_id',
      'runtimeArtifactId', 'selected_artifact_id', 'selectedArtifactId',
      'new_artifact_hash', 'newArtifactHash', 'hash',
    ],
    ['process_id', 'processId', 'pid'],
    ['publication_id', 'publicationId'],
    ['candidate_registration_id', 'candidateRegistrationId'],
    ['dispatcher_registration_id', 'dispatcherRegistrationId'],
    ['previous_epoch', 'previousEpoch'],
    ['device_uuid', 'deviceUuid', 'device_id', 'deviceId'],
    ['timestamp_monotonic_ns', 'timestampMonotonicNs', 'timestamp_ms', 'timestampMs', 'ts'],
    ['passed', 'success', 'succeeded', 'accepted', 'gpu_hmr_success', 'gpuHmrSuccess'],
  ];
  if (mode === 'output') {
    aliasGroups.push(['after_dispatch_id', 'afterDispatchId', 'dispatch_id', 'dispatchId']);
    const outputTargetIds = [
      event.output_target,
      event.outputTarget,
      event.output_target_id,
      event.outputTargetId,
      event.target_id,
      event.targetId,
    ].flatMap((value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return compactStringList([value.id, value.target_id, value.targetId]);
      }
      return compactStringList([value]);
    });
    if (new Set(outputTargetIds).size > 1) return true;
  }
  if (mode === 'retirement') {
    aliasGroups.push(
      ['status', 'result', 'retirement_result', 'retirementResult'],
      ['proof', 'retirement_proof', 'retirementProof'],
    );
  }
  return aliasGroups.some((keys) => {
    const values = keys
      .filter((key) => hasOwn(event, key))
      .map((key) => stableJson(event[key]));
    return new Set(values).size > 1;
  });
}

function portableMonotonicTimestamp(event) {
  const value = event.timestamp_monotonic_ns ?? event.timestampMonotonicNs;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function portableCanonicalJsonNumbersSupported(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(portableCanonicalJsonNumbersSupported);
  if (value && typeof value === 'object') {
    return Object.values(value).every(portableCanonicalJsonNumbersSupported);
  }
  return true;
}

function canonicalDecimalEpoch(value) {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) ? value : null;
}

function forwardEpochTransition(previousEpoch, candidateEpoch) {
  const previous = canonicalDecimalEpoch(previousEpoch);
  const candidate = canonicalDecimalEpoch(candidateEpoch);
  return previous !== null
    && candidate !== null
    && BigInt(candidate) > BigInt(previous);
}

function rawEventEpoch(event) {
  return aliasGroupFirstValue(event, ['epoch', 'epoch_id', 'epochId', 'generation']);
}

function rawPreviousEpoch(event) {
  return aliasGroupFirstValue(event, ['previous_epoch', 'previousEpoch']);
}

function withoutVisualCaptureRuntimeBinding(value) {
  if (Array.isArray(value)) return value.map(withoutVisualCaptureRuntimeBinding);
  if (value === null || typeof value !== 'object') return value;
  const visualArtifactContainer = [
    'before_image',
    'beforeImage',
    'after_image',
    'afterImage',
    'diff_image',
    'diffImage',
    'before_image_hash',
    'beforeImageHash',
    'after_image_hash',
    'afterImageHash',
    'diff_image_hash',
    'diffImageHash',
  ].some((key) => hasOwn(value, key));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !(visualArtifactContainer && [
      'visual_capture_runtime_binding',
      'visualCaptureRuntimeBinding',
    ].includes(key)))
    .map(([key, entry]) => [key, withoutVisualCaptureRuntimeBinding(entry)]));
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function canonicalLedgerProofId(input) {
  return `gpu-ledger-proof:sha256:${sha256Hex(stableJson(input))}`;
}

function canonicalLedgerRootProofId(recordProofIds) {
  if (recordProofIds.length === 0 || recordProofIds.some((proofId) => !proofId)) {
    return null;
  }
  if (recordProofIds.length === 1) return recordProofIds[0];
  return canonicalLedgerProofId({
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    records: recordProofIds,
  });
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

function modelPolicyRoleFromValue(value) {
  const object = asObject(value);
  const provider = firstText(object.provider, object.model_provider, object.modelProvider);
  const model = firstText(object.model, object.required_model, object.requiredModel);
  return provider && model ? { provider, model } : null;
}

function modelPolicyAliasesFromValue(value) {
  const object = asObject(value);
  const aliases = {};
  for (const [provider, rawAliases] of Object.entries(object)) {
    const canonicalProvider = text(provider);
    if (!canonicalProvider) continue;
    const values = compactStringList(Array.isArray(rawAliases) ? rawAliases : [rawAliases]);
    aliases[canonicalProvider] = values.length > 0 ? values : [canonicalProvider];
  }
  return aliases;
}

function resolveGpuHmrModelPolicy(...candidates) {
  const policy = {
    roles: {
      split: { ...DEFAULT_GPU_HMR_MODEL_POLICY.roles.split },
      gpu_delta: { ...DEFAULT_GPU_HMR_MODEL_POLICY.roles.gpu_delta },
    },
    providerAliases: Object.fromEntries(
      Object.entries(DEFAULT_GPU_HMR_MODEL_POLICY.providerAliases)
        .map(([provider, aliases]) => [provider, [...aliases]]),
    ),
  };
  for (const candidate of candidates) {
    const object = asObject(candidate);
    if (Object.keys(object).length === 0) continue;
    const roles = asObject(object.roles ?? object.model_roles ?? object.modelRoles);
    for (const role of ['split', 'gpu_delta']) {
      const roleValue = modelPolicyRoleFromValue(
        roles[role]
        ?? object[role]
        ?? object[role === 'gpu_delta' ? 'gpuDelta' : role],
      );
      if (roleValue) policy.roles[role] = roleValue;
    }
    const providerAliases = modelPolicyAliasesFromValue(
      object.providerAliases
      ?? object.provider_aliases
      ?? object.aliases
      ?? object.provider_alias_map,
    );
    for (const [provider, aliases] of Object.entries(providerAliases)) {
      policy.providerAliases[provider] = compactStringList([provider, ...aliases]);
    }
  }
  return policy;
}

function normalizeModelProvider(value, policy = DEFAULT_GPU_HMR_MODEL_POLICY) {
  const provider = firstText(value);
  if (!provider) return null;
  const aliases = asObject(policy.providerAliases ?? policy.provider_aliases);
  for (const [canonical, rawAliases] of Object.entries(aliases)) {
    const canonicalProvider = text(canonical);
    if (!canonicalProvider) continue;
    const values = compactStringList([canonicalProvider, ...(Array.isArray(rawAliases) ? rawAliases : [rawAliases])]);
    if (values.includes(provider)) return canonicalProvider;
  }
  return provider;
}

function identifierText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value);
}

function firstIdentifierText(...values) {
  for (const value of values) {
    const normalized = identifierText(value);
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
  return firstIdentifierText(event.process_id, event.processId, event.pid);
}

function eventRuntimeSessionId(event) {
  return firstText(
    event.runtime_session_id,
    event.runtimeSessionId,
    event.runtime_session,
    event.runtimeSession,
  );
}

function eventDeviceId(event) {
  return firstIdentifierText(
    event.device_uuid,
    event.deviceUuid,
    event.device_id,
    event.deviceId,
  );
}

function firewallProcessIdBefore(evidence) {
  return firstIdentifierText(
    evidence.process_id_before,
    evidence.processIdBefore,
    evidence.firewall_process_id_before,
    evidence.firewallProcessIdBefore,
  );
}

function firewallProcessIdAfter(evidence) {
  return firstIdentifierText(
    evidence.process_id_after,
    evidence.processIdAfter,
    evidence.firewall_process_id_after,
    evidence.firewallProcessIdAfter,
  );
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

function eventTimestampBinding(event, metricClock) {
  const monotonicNs = finiteNumber(
    event.timestamp_monotonic_ns ?? event.timestampMonotonicNs,
  );
  if (monotonicNs !== null) return { clock: 'monotonic_ns', value: monotonicNs };
  const timestampMs = finiteNumber(event.timestamp_ms ?? event.timestampMs);
  if (timestampMs !== null) return { clock: 'unix_epoch_ms', value: timestampMs };
  const genericTimestamp = finiteNumber(event.ts);
  if (genericTimestamp === null || !firstText(metricClock)) return null;
  return { clock: firstText(metricClock), value: genericTimestamp };
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

function outputOracleTargetModalityValues(target) {
  const kind = target.kind;
  return compactStringList([
    kind && typeof kind === 'object' && !Array.isArray(kind) ? asObject(kind).value : kind,
    target.target_kind,
    target.targetKind,
  ]).map((value) => value.toLowerCase());
}

function outputOracleTargetIdValues(target) {
  return compactStringList([target.id, target.target_id, target.targetId]);
}

function outputOracleTargetEvidenceRefSets(target) {
  return [target.evidence_refs, target.evidenceRefs]
    .filter((value) => value !== undefined)
    .map((value) => stableJson(compactStringList(value).sort()));
}

function outputOracleTargetInternalMismatch(target) {
  return new Set(outputOracleTargetModalityValues(target)).size > 1
    || new Set(outputOracleTargetIdValues(target)).size > 1
    || new Set(outputOracleTargetEvidenceRefSets(target)).size > 1;
}

function outputOracleTargetDeclarationProjections(record) {
  const outputEvent = asObject(record.output_event ?? record.outputEvent);
  const outputOracle = asObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
  return [
    record.output_oracle_target,
    record.outputOracleTarget,
    outputEvent.output_oracle_target,
    outputEvent.outputOracleTarget,
    outputOracle.output_oracle_target,
    outputOracle.outputOracleTarget,
  ]
    .filter((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate))
    .map((candidate) => {
      const target = asObject(candidate);
      return stableJson({
        modality: outputOracleTargetModality(target),
        targetId: outputOracleTargetId(target),
        evidenceRefs: outputOracleTargetEvidenceRefs(target).sort(),
      });
    });
}

function outputOracleTargetDeclarationMismatch(record) {
  const outputEvent = asObject(record.output_event ?? record.outputEvent);
  const outputOracle = asObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
  const declarations = [
    record.output_oracle_target,
    record.outputOracleTarget,
    outputEvent.output_oracle_target,
    outputEvent.outputOracleTarget,
    outputOracle.output_oracle_target,
    outputOracle.outputOracleTarget,
  ]
    .filter((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate))
    .map(asObject);
  return declarations.some(outputOracleTargetInternalMismatch)
    || new Set(outputOracleTargetDeclarationProjections(record)).size > 1;
}

function outputOracleTargetModality(target) {
  return outputOracleTargetModalityValues(target)[0] ?? null;
}

function outputOracleTargetId(target) {
  return outputOracleTargetIdValues(target)[0] ?? null;
}

function outputEventTargetId(outputEvent) {
  const eventTarget = asObject(outputEvent.output_target ?? outputEvent.outputTarget);
  return firstText(
    typeof outputEvent.output_target === 'string' ? outputEvent.output_target : null,
    typeof outputEvent.outputTarget === 'string' ? outputEvent.outputTarget : null,
    outputEvent.output_target_id,
    outputEvent.outputTargetId,
    outputEvent.target_id,
    outputEvent.targetId,
    eventTarget.id,
    eventTarget.target_id,
    eventTarget.targetId,
  );
}

function outputOracleTargetEvidenceRefs(target) {
  return compactStringList(target.evidence_refs ?? target.evidenceRefs);
}

function visualOutputTargetId(record) {
  const outputEvent = asObject(record.output_event ?? record.outputEvent);
  const oracleTarget = outputOracleTarget(record);
  return firstText(
    outputEventTargetId(outputEvent),
    outputOracleTargetId(oracleTarget),
  );
}

function visualOutputTargetValue(record) {
  const outputEvent = asObject(record.output_event ?? record.outputEvent);
  const outputOracle = asObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
  return outputEvent.output_target
    ?? outputEvent.outputTarget
    ?? outputEvent.output_oracle_target
    ?? outputEvent.outputOracleTarget
    ?? record.output_oracle_target
    ?? record.outputOracleTarget
    ?? outputOracle.output_oracle_target
    ?? outputOracle.outputOracleTarget
    ?? null;
}

function runtimeSessionId(record) {
  const processIdentity = asObject(record.process_identity ?? record.processIdentity);
  const dispatchEvent = asObject(record.dispatch_event ?? record.dispatchEvent);
  const outputEvent = asObject(record.output_event ?? record.outputEvent);
  return firstText(
    record.runtime_session_id,
    record.runtimeSessionId,
    processIdentity.runtime_session_id,
    processIdentity.runtimeSessionId,
    processIdentity.runtime_session,
    processIdentity.runtimeSession,
    dispatchEvent.runtime_session_id,
    dispatchEvent.runtimeSessionId,
    dispatchEvent.runtime_session,
    dispatchEvent.runtimeSession,
    outputEvent.runtime_session_id,
    outputEvent.runtimeSessionId,
    outputEvent.runtime_session,
    outputEvent.runtimeSession,
  );
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

function computeOracleArtifactOverlay(options, recordIndex = 0) {
  const overlays = asObject(options.computeOracleArtifactOverlays ?? options.compute_oracle_artifact_overlays);
  const list = Array.isArray(options.computeOracleArtifactOverlays)
    ? options.computeOracleArtifactOverlays
    : Array.isArray(options.compute_oracle_artifact_overlays)
      ? options.compute_oracle_artifact_overlays
      : null;
  const direct = asObject(options.computeOracleArtifactOverlay ?? options.compute_oracle_artifact_overlay);
  const indexed = list
    ? asObject(list[recordIndex])
    : asObject(overlays[recordIndex] ?? overlays[String(recordIndex)]);
  if (Object.keys(indexed).length > 0) return indexed;
  if (recordIndex === 0 && Object.keys(direct).length > 0) return direct;
  return null;
}

function visualOracleArtifactOverlay(options, recordIndex = 0) {
  const overlays = asObject(options.visualOracleArtifactOverlays ?? options.visual_oracle_artifact_overlays);
  const list = Array.isArray(options.visualOracleArtifactOverlays)
    ? options.visualOracleArtifactOverlays
    : Array.isArray(options.visual_oracle_artifact_overlays)
      ? options.visual_oracle_artifact_overlays
      : null;
  const direct = asObject(options.visualOracleArtifactOverlay ?? options.visual_oracle_artifact_overlay);
  const indexed = list
    ? asObject(list[recordIndex])
    : asObject(overlays[recordIndex] ?? overlays[String(recordIndex)]);
  if (Object.keys(indexed).length > 0) return indexed;
  if (recordIndex === 0 && Object.keys(direct).length > 0) return direct;
  return null;
}

function mergeComputeOracleArtifactOverlay(artifacts, overlay) {
  const base = asObject(artifacts);
  const resolved = asObject(overlay);
  if (Object.keys(resolved).length === 0) return artifacts;
  return {
    ...base,
    ...resolved,
    proofAuthority: firstText(
      resolved.proofAuthority,
      resolved.proof_authority,
      base.proofAuthority,
      base.proof_authority,
      'resolved_compute_artifact_overlay_transport_integrity_only',
    ),
    proof_authority: firstText(
      resolved.proof_authority,
      resolved.proofAuthority,
      base.proof_authority,
      base.proofAuthority,
      'resolved_compute_artifact_overlay_transport_integrity_only',
    ),
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
  };
}

function mergeVisualOracleArtifactOverlay(artifacts, overlay) {
  const base = asObject(artifacts);
  const resolved = asObject(overlay);
  if (Object.keys(resolved).length === 0) return artifacts;
  return {
    ...base,
    ...resolved,
    proofAuthority: firstText(
      resolved.proofAuthority,
      resolved.proof_authority,
      base.proofAuthority,
      base.proof_authority,
      'resolved_visual_artifact_overlay_transport_integrity_only',
    ),
    proof_authority: firstText(
      resolved.proof_authority,
      resolved.proofAuthority,
      base.proof_authority,
      base.proofAuthority,
      'resolved_visual_artifact_overlay_transport_integrity_only',
    ),
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
  };
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

function canonicalSha256(value) {
  const digest = computeSha256Digest(value);
  return digest ? `sha256:${digest}` : null;
}

function canonicalArtifactSha256(value) {
  const text = firstText(value);
  return canonicalSha256(text?.replace(/^artifact:/i, ''));
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

function visualCaptureRuntimeBindingObject(artifacts) {
  return nonEmptyObject(objectFieldValue(artifacts, [
    'visual_capture_runtime_binding',
    'visualCaptureRuntimeBinding',
  ]));
}

function visualCaptureRuntimeBindingProofIdentity(record) {
  const artifacts = visualOracleArtifacts(record.oracleArtifacts, record.outputEvent);
  const supplied = visualCaptureRuntimeBindingObject(artifacts);
  if (!supplied) return null;
  const identity = { ...supplied };
  delete identity.proof_ledger_id;
  delete identity.proofLedgerId;
  delete identity.binding_hash;
  delete identity.bindingHash;
  return identity;
}

function visualCaptureManifestObject(artifacts) {
  return nonEmptyObject(objectFieldValue(artifacts, [
    'capture_manifest',
    'captureManifest',
    'after_capture_manifest',
    'afterCaptureManifest',
  ]));
}

function visualCaptureFrameGateObject(captureManifest) {
  return nonEmptyObject(objectFieldValue(captureManifest, ['frame_gate', 'frameGate']));
}

function visualCaptureFrameGateRuntimeBindingObject(frameGate) {
  const source = asObject(frameGate);
  return hasOwn(source, 'evidence_binding')
    ? nonEmptyObject(source.evidence_binding)
    : null;
}

function visualCaptureFrameGateRuntimeBindingTransport(captureManifest, frameGate) {
  const manifest = asObject(captureManifest);
  const gate = asObject(frameGate);
  const runtimeBinding = visualCaptureFrameGateRuntimeBindingObject(gate);
  const bindingPresent = hasOwn(gate, 'evidence_binding');
  const bindingHashPresent = hasOwn(gate, 'evidence_binding_hash');
  const suppliedBindingHash = bindingHashPresent
    ? canonicalSha256(firstText(gate.evidence_binding_hash))
    : null;
  const recomputedBindingHash = runtimeBinding
    ? `sha256:${sha256Hex(stableJson(runtimeBinding))}`
    : null;
  const manifestBindingPresent = hasOwn(manifest, 'evidence_binding');
  const manifestBinding = manifestBindingPresent
    ? nonEmptyObject(manifest.evidence_binding)
    : null;
  const manifestBindingHashPresent = hasOwn(manifest, 'evidence_binding_hash');
  const manifestBindingHash = manifestBindingHashPresent
    ? canonicalSha256(firstText(manifest.evidence_binding_hash))
    : null;
  const forbiddenAliases = [];
  const aliasFields = [
    'evidenceBinding',
    'evidenceBindingHash',
    'gpu_hmr_runtime_binding',
    'gpuHmrRuntimeBinding',
    'runtime_binding',
    'runtimeBinding',
  ];
  for (const [container, source] of [['frame_gate', gate], ['capture_manifest', manifest]]) {
    for (const field of aliasFields) {
      if (hasOwn(source, field)) forbiddenAliases.push(`${container}.${field}`);
    }
  }
  return {
    runtimeBinding,
    bindingPresent,
    bindingHashPresent,
    suppliedBindingHash,
    recomputedBindingHash,
    manifestBindingPresent,
    manifestBinding,
    manifestBindingHashPresent,
    manifestBindingHash,
    forbiddenAliases,
  };
}

function timestampBindingProjection(value) {
  const source = asObject(value);
  return {
    clock: firstText(source.clock, source.metric_clock, source.metricClock),
    value: finiteNumber(source.value ?? source.timestamp),
  };
}

function visualFrameGateRuntimeBindingProjection(record) {
  const epochPublishEvent = asObject(record.epochPublishEvent ?? record.epoch_publish_event);
  const dispatchEvent = asObject(record.dispatchEvent ?? record.dispatch_event);
  const outputEvent = asObject(record.outputEvent ?? record.output_event);
  const processIdentity = asObject(record.processIdentity ?? record.process_identity);
  const deviceIdentity = asObject(record.deviceIdentity ?? record.device_identity);
  return {
    schema_version: GPU_HMR_FRAME_GATE_RUNTIME_BINDING_SCHEMA_VERSION,
    proof_authority: GPU_HMR_FRAME_GATE_RUNTIME_BINDING_AUTHORITY,
    runtime_proof_id: firstText(record.runtimeProofId, record.runtime_proof_id),
    runtime_proof_state: firstText(record.runtimeProofState, record.runtime_proof_state),
    runtime_proof_accepted:
      record.runtimeProofAccepted === true || record.runtime_proof_accepted === true,
    runtime_proof_observed_at_ms: finiteNumber(
      record.runtimeProofObservedAtMs ?? record.runtime_proof_observed_at_ms,
    ),
    hmr_observed_at_ms: finiteNumber(record.hmrObservedAtMs ?? record.hmr_observed_at_ms),
    artifact_after_hash: canonicalArtifactSha256(firstText(
      record.artifactAfterHash,
      record.artifact_after_hash,
    )),
    epoch_publish_event_id: eventId(epochPublishEvent),
    published_epoch: eventEpoch(epochPublishEvent),
    dispatch_id: eventId(dispatchEvent),
    dispatch_epoch: eventEpoch(dispatchEvent),
    dispatch_artifact_hash: canonicalArtifactSha256(eventArtifactHash(dispatchEvent)),
    dispatch_timestamp: eventTimestampBinding(dispatchEvent, record.metricClock),
    output_event_id: eventId(outputEvent),
    output_after_dispatch_id: outputAfterDispatchId(outputEvent),
    output_epoch: eventEpoch(outputEvent),
    output_artifact_hash: canonicalArtifactSha256(eventArtifactHash(outputEvent)),
    output_target_id: visualOutputTargetId(record),
    output_target_hash: `sha256:${sha256Hex(stableJson(visualOutputTargetValue(record)))}`,
    output_timestamp: eventTimestampBinding(outputEvent, record.metricClock),
    process_id: eventProcessId(processIdentity),
    process_identity_hash: `sha256:${sha256Hex(stableJson(processIdentity))}`,
    runtime_session_id: firstText(record.runtimeSessionId, record.runtime_session_id),
    device_id: firstIdentifierText(
      deviceIdentity.device_uuid,
      deviceIdentity.deviceUuid,
      deviceIdentity.device_id,
      deviceIdentity.deviceId,
    ),
    metric_clock: firstText(record.metricClock, record.metric_clock),
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    can_satisfy_runtime_proof: false,
    can_satisfy_dispatch_proof: false,
  };
}

export function buildGpuHmrFrameGateRuntimeBinding(input = {}) {
  const record = normalizeGpuHmrProofLedgerRecord(input);
  const projection = visualFrameGateRuntimeBindingProjection(record);
  const missingFields = missingVisualFrameGateRuntimeBindingFields(projection);
  if (missingFields.length > 0) {
    throw new Error(
      `visual_frame_gate_runtime_binding_material_incomplete:${missingFields.join(',')}`,
    );
  }
  return Object.freeze(projection);
}

function canonicalVisualFrameGateRuntimeBinding(value) {
  const source = asObject(value);
  return {
    schema_version: firstText(source.schema_version, source.schemaVersion),
    proof_authority: firstText(source.proof_authority, source.proofAuthority),
    runtime_proof_id: firstText(source.runtime_proof_id, source.runtimeProofId),
    runtime_proof_state: firstText(source.runtime_proof_state, source.runtimeProofState),
    runtime_proof_accepted:
      source.runtime_proof_accepted === true || source.runtimeProofAccepted === true,
    runtime_proof_observed_at_ms: finiteNumber(
      source.runtime_proof_observed_at_ms ?? source.runtimeProofObservedAtMs,
    ),
    hmr_observed_at_ms: finiteNumber(source.hmr_observed_at_ms ?? source.hmrObservedAtMs),
    artifact_after_hash: canonicalArtifactSha256(firstText(
      source.artifact_after_hash,
      source.artifactAfterHash,
    )),
    epoch_publish_event_id: firstText(
      source.epoch_publish_event_id,
      source.epochPublishEventId,
    ),
    published_epoch: firstText(source.published_epoch, source.publishedEpoch),
    dispatch_id: firstText(source.dispatch_id, source.dispatchId),
    dispatch_epoch: firstText(source.dispatch_epoch, source.dispatchEpoch),
    dispatch_artifact_hash: canonicalArtifactSha256(firstText(
      source.dispatch_artifact_hash,
      source.dispatchArtifactHash,
    )),
    dispatch_timestamp: timestampBindingProjection(
      source.dispatch_timestamp ?? source.dispatchTimestamp,
    ),
    output_event_id: firstText(source.output_event_id, source.outputEventId),
    output_after_dispatch_id: firstText(
      source.output_after_dispatch_id,
      source.outputAfterDispatchId,
    ),
    output_epoch: firstText(source.output_epoch, source.outputEpoch),
    output_artifact_hash: canonicalArtifactSha256(firstText(
      source.output_artifact_hash,
      source.outputArtifactHash,
    )),
    output_target_id: firstText(source.output_target_id, source.outputTargetId),
    output_target_hash: canonicalSha256(firstText(
      source.output_target_hash,
      source.outputTargetHash,
    )),
    output_timestamp: timestampBindingProjection(
      source.output_timestamp ?? source.outputTimestamp,
    ),
    process_id: firstIdentifierText(source.process_id, source.processId),
    process_identity_hash: canonicalSha256(firstText(
      source.process_identity_hash,
      source.processIdentityHash,
    )),
    runtime_session_id: firstText(source.runtime_session_id, source.runtimeSessionId),
    device_id: firstIdentifierText(source.device_id, source.deviceId),
    metric_clock: firstText(source.metric_clock, source.metricClock),
    accepted_for_gpu_hmr: source.accepted_for_gpu_hmr === false
      && source.acceptedForGpuHmr !== true ? false : true,
    gpu_hmr_success: source.gpu_hmr_success === false
      && source.gpuHmrSuccess !== true ? false : true,
    can_satisfy_runtime_proof: source.can_satisfy_runtime_proof === false
      && source.canSatisfyRuntimeProof !== true ? false : true,
    can_satisfy_dispatch_proof: source.can_satisfy_dispatch_proof === false
      && source.canSatisfyDispatchProof !== true ? false : true,
  };
}

function missingVisualFrameGateRuntimeBindingFields(projection) {
  return Object.entries(projection)
    .filter(([key, value]) => {
      if (key === 'runtime_proof_accepted') return value !== true;
      if ([
        'accepted_for_gpu_hmr',
        'gpu_hmr_success',
        'can_satisfy_runtime_proof',
        'can_satisfy_dispatch_proof',
      ].includes(key)) return value !== false;
      if (key === 'dispatch_timestamp' || key === 'output_timestamp') {
        return !firstText(value?.clock) || finiteNumber(value?.value) === null;
      }
      return value === null || value === undefined || value === '';
    })
    .map(([key]) => key);
}

function visualFrameGateRuntimeIdentityEvaluation(record) {
  const processIdentity = asObject(record.processIdentity ?? record.process_identity);
  const deviceIdentity = asObject(record.deviceIdentity ?? record.device_identity);
  const loaderEvent = asObject(record.loaderEvent ?? record.loader_event);
  const epochPublishEvent = asObject(record.epochPublishEvent ?? record.epoch_publish_event);
  const dispatchEvent = asObject(record.dispatchEvent ?? record.dispatch_event);
  const outputEvent = asObject(record.outputEvent ?? record.output_event);
  const processLocations = {
    process_identity: eventProcessId(processIdentity),
    loader_event: eventProcessId(loaderEvent),
    epoch_publish_event: eventProcessId(epochPublishEvent),
    dispatch_event: eventProcessId(dispatchEvent),
    output_event: eventProcessId(outputEvent),
  };
  const runtimeSessionLocations = {
    record: firstText(record.runtimeSessionId, record.runtime_session_id),
    process_identity: eventRuntimeSessionId(processIdentity),
    loader_event: eventRuntimeSessionId(loaderEvent),
    epoch_publish_event: eventRuntimeSessionId(epochPublishEvent),
    dispatch_event: eventRuntimeSessionId(dispatchEvent),
    output_event: eventRuntimeSessionId(outputEvent),
  };
  const deviceLocations = {
    device_identity: eventDeviceId(deviceIdentity),
    loader_event: eventDeviceId(loaderEvent),
    epoch_publish_event: eventDeviceId(epochPublishEvent),
    dispatch_event: eventDeviceId(dispatchEvent),
    output_event: eventDeviceId(outputEvent),
  };
  const failures = [];
  for (const [kind, locations] of [
    ['process', processLocations],
    ['session', runtimeSessionLocations],
    ['device', deviceLocations],
  ]) {
    const missingLocations = Object.entries(locations)
      .filter(([, value]) => !value)
      .map(([location]) => location);
    const identities = [...new Set(Object.values(locations).filter(Boolean))];
    if (missingLocations.length > 0) {
      failures.push({
        code: `visual_capture_runtime_${kind}_identity_material_incomplete`,
        missingLocations,
      });
    }
    if (identities.length !== 1) {
      failures.push({
        code: `visual_capture_runtime_${kind}_identity_not_unique`,
        identities,
      });
    }
  }
  return {
    accepted: failures.length === 0,
    failures,
    processLocations,
    runtimeSessionLocations,
    deviceLocations,
  };
}

function visualCaptureManifestEvaluation(record, artifacts) {
  const failures = [];
  const captureManifest = visualCaptureManifestObject(artifacts);
  const frameGate = visualCaptureFrameGateObject(captureManifest);
  const runtimeBindingTransport = visualCaptureFrameGateRuntimeBindingTransport(
    captureManifest,
    frameGate,
  );
  const suppliedRuntimeBinding = runtimeBindingTransport.runtimeBinding;
  const expectedRuntimeBinding = visualFrameGateRuntimeBindingProjection(record);
  const canonicalRuntimeBinding = suppliedRuntimeBinding
    ? canonicalVisualFrameGateRuntimeBinding(suppliedRuntimeBinding)
    : null;
  const runtimeIdentityEvaluation = visualFrameGateRuntimeIdentityEvaluation(record);
  const pixelVerification = visualPixelVerification(artifacts);
  const afterImageHash = canonicalSha256(visualArtifactHash(
    artifacts,
    pixelVerification,
    ['after_image_hash', 'afterImageHash'],
    ['after_image_hash', 'afterImageHash'],
  ));
  const swapchainSize = artifactFieldArray(
    artifacts,
    'swapchain_size',
    'swapchainSize',
  ).map((value) => Number(value));

  if (!captureManifest) failures.push({ code: 'visual_capture_manifest_missing' });
  if (captureManifest && firstText(
    captureManifest.schema_version,
    captureManifest.schemaVersion,
  ) !== 'synthi.mcp.capture_manifest.v1') {
    failures.push({ code: 'visual_capture_manifest_schema_invalid' });
  }
  if (!frameGate) failures.push({ code: 'visual_capture_manifest_frame_gate_missing' });
  if (
    captureManifest
    && (
      captureManifest.accepted_for_gpu_hmr === true
      || captureManifest.acceptedForGpuHmr === true
      || captureManifest.gpu_hmr_success === true
      || captureManifest.gpuHmrSuccess === true
    )
  ) {
    failures.push({ code: 'visual_capture_manifest_success_authority_forbidden' });
  }

  const manifestImageHash = canonicalSha256(firstText(
    captureManifest?.image_sha256,
    captureManifest?.imageSha256,
  ));
  const imageByteLength = finiteNumber(
    captureManifest?.image_byte_length ?? captureManifest?.imageByteLength,
  );
  if (!manifestImageHash || manifestImageHash !== afterImageHash) {
    failures.push({ code: 'visual_capture_manifest_image_hash_mismatch' });
  }
  if (!Number.isInteger(imageByteLength) || imageByteLength <= 0) {
    failures.push({ code: 'visual_capture_manifest_image_byte_length_invalid' });
  }
  const manifestCaptureBackend = firstText(
    captureManifest?.capture_backend,
    captureManifest?.captureBackend,
  );
  if (manifestCaptureBackend !== artifactFieldText(
    artifacts,
    'capture_backend',
    'captureBackend',
  )) {
    failures.push({ code: 'visual_capture_manifest_backend_mismatch' });
  }
  const manifestWidth = finiteNumber(captureManifest?.width);
  const manifestHeight = finiteNumber(captureManifest?.height);
  if (
    swapchainSize.length !== 2
    || !Number.isInteger(manifestWidth)
    || !Number.isInteger(manifestHeight)
    || manifestWidth !== swapchainSize[0]
    || manifestHeight !== swapchainSize[1]
  ) {
    failures.push({ code: 'visual_capture_manifest_dimensions_mismatch' });
  }

  const manifestSession = firstText(captureManifest?.session_id, captureManifest?.sessionId);
  const frameGateSession = firstText(frameGate?.session_id, frameGate?.sessionId);
  const manifestGateToken = firstText(captureManifest?.gate_token, captureManifest?.gateToken);
  const frameGateToken = firstText(frameGate?.gate_token, frameGate?.gateToken);
  if (
    captureManifest?.gate_token_verified !== true
    || frameGate?.gate_token_verified !== true
    || !manifestGateToken
    || manifestGateToken !== frameGateToken
  ) {
    failures.push({ code: 'visual_capture_manifest_gate_unverified' });
  }
  if (!manifestSession || manifestSession !== frameGateSession) {
    failures.push({ code: 'visual_capture_manifest_session_mismatch' });
  }

  if (runtimeBindingTransport.forbiddenAliases.length > 0) {
    failures.push({
      code: 'visual_capture_manifest_runtime_binding_alias_forbidden',
      fields: runtimeBindingTransport.forbiddenAliases,
    });
  }
  if (!runtimeBindingTransport.bindingPresent || !suppliedRuntimeBinding) {
    failures.push({ code: 'visual_capture_manifest_evidence_binding_missing' });
  }
  if (!runtimeBindingTransport.bindingHashPresent) {
    failures.push({ code: 'visual_capture_manifest_evidence_binding_hash_missing' });
  } else if (!runtimeBindingTransport.suppliedBindingHash) {
    failures.push({ code: 'visual_capture_manifest_evidence_binding_hash_invalid' });
  } else if (
    runtimeBindingTransport.suppliedBindingHash
      !== runtimeBindingTransport.recomputedBindingHash
  ) {
    failures.push({ code: 'visual_capture_manifest_evidence_binding_hash_mismatch' });
  }
  if (
    runtimeBindingTransport.manifestBindingPresent
    || runtimeBindingTransport.manifestBindingHashPresent
  ) {
    if (
      !runtimeBindingTransport.manifestBinding
      || !runtimeBindingTransport.manifestBindingHashPresent
      || !runtimeBindingTransport.manifestBindingHash
      || stableJson(runtimeBindingTransport.manifestBinding)
        !== stableJson(suppliedRuntimeBinding)
      || runtimeBindingTransport.manifestBindingHash
        !== runtimeBindingTransport.suppliedBindingHash
    ) {
      failures.push({ code: 'visual_capture_manifest_evidence_binding_transport_mismatch' });
    }
  }

  const frameSeq = finiteNumber(captureManifest?.frame_seq ?? captureManifest?.frameSeq);
  const frameTsMs = finiteNumber(captureManifest?.frame_ts_ms ?? captureManifest?.frameTsMs);
  const captureTsMs = finiteNumber(
    captureManifest?.capture_ts_ms ?? captureManifest?.captureTsMs,
  );
  const requiredFrameSeq = finiteNumber(
    captureManifest?.required_frame_seq
    ?? captureManifest?.requiredFrameSeq
    ?? frameGate?.required_frame_seq
    ?? frameGate?.requiredFrameSeq,
  );
  const requiredTsMs = finiteNumber(
    captureManifest?.required_ts_ms
    ?? captureManifest?.requiredTsMs
    ?? frameGate?.required_ts_ms
    ?? frameGate?.requiredTsMs,
  );
  const capturedFrameSeq = finiteNumber(
    frameGate?.captured_frame_seq ?? frameGate?.capturedFrameSeq,
  );
  const capturedTsMs = finiteNumber(frameGate?.captured_ts_ms ?? frameGate?.capturedTsMs);
  const gateIssuedAtMs = finiteNumber(
    frameGate?.gate_token_issued_at_ms ?? frameGate?.gateTokenIssuedAtMs,
  );
  const gateExpiresAtMs = finiteNumber(
    frameGate?.gate_token_expires_at_ms ?? frameGate?.gateTokenExpiresAtMs,
  );
  if (
    !Number.isInteger(frameSeq)
    || frameSeq < 0
    || frameSeq !== capturedFrameSeq
    || !Number.isInteger(requiredFrameSeq)
    || requiredFrameSeq < 0
    || frameSeq < requiredFrameSeq
  ) {
    failures.push({ code: 'visual_capture_manifest_frame_sequence_invalid' });
  }
  if (
    frameTsMs === null
    || captureTsMs === null
    || requiredTsMs === null
    || capturedTsMs !== frameTsMs
    || frameTsMs < requiredTsMs
    || gateIssuedAtMs === null
    || gateExpiresAtMs === null
    || captureTsMs < gateIssuedAtMs
    || captureTsMs > gateExpiresAtMs
  ) {
    failures.push({ code: 'visual_capture_manifest_timestamp_order_invalid' });
  }

  const missingRuntimeFields = missingVisualFrameGateRuntimeBindingFields(
    expectedRuntimeBinding,
  );
  failures.push(...runtimeIdentityEvaluation.failures);
  if (missingRuntimeFields.length > 0) {
    failures.push({
      code: 'visual_capture_runtime_binding_material_incomplete',
      missingFields: missingRuntimeFields,
    });
  }
  if (!suppliedRuntimeBinding) {
    failures.push({ code: 'visual_capture_manifest_runtime_binding_missing' });
  } else {
    if (
      canonicalRuntimeBinding.schema_version
        !== GPU_HMR_FRAME_GATE_RUNTIME_BINDING_SCHEMA_VERSION
      || canonicalRuntimeBinding.proof_authority
        !== GPU_HMR_FRAME_GATE_RUNTIME_BINDING_AUTHORITY
      || canonicalRuntimeBinding.accepted_for_gpu_hmr !== false
      || canonicalRuntimeBinding.gpu_hmr_success !== false
      || canonicalRuntimeBinding.can_satisfy_runtime_proof !== false
      || canonicalRuntimeBinding.can_satisfy_dispatch_proof !== false
    ) {
      failures.push({ code: 'visual_capture_manifest_runtime_binding_authority_invalid' });
    }
    if (stableJson(canonicalRuntimeBinding) !== stableJson(expectedRuntimeBinding)) {
      failures.push({ code: 'visual_capture_manifest_runtime_binding_mismatch' });
    }
  }
  const dispatchTimestamp = expectedRuntimeBinding.dispatch_timestamp;
  const outputTimestamp = expectedRuntimeBinding.output_timestamp;
  if (
    dispatchTimestamp?.clock !== 'monotonic_ns'
    || outputTimestamp?.clock !== 'monotonic_ns'
    || expectedRuntimeBinding.metric_clock !== 'monotonic_ns'
    || dispatchTimestamp.value > outputTimestamp.value
  ) {
    failures.push({ code: 'visual_capture_runtime_binding_clock_domain_invalid' });
  }
  if (
    expectedRuntimeBinding.runtime_proof_state !== 'gpu-hmr-full-runtime-proven'
    || expectedRuntimeBinding.runtime_proof_observed_at_ms
      < expectedRuntimeBinding.hmr_observed_at_ms
    || gateIssuedAtMs < expectedRuntimeBinding.runtime_proof_observed_at_ms
    || requiredTsMs < expectedRuntimeBinding.hmr_observed_at_ms
  ) {
    failures.push({ code: 'visual_capture_runtime_binding_proof_gate_order_invalid' });
  }

  return {
    accepted: failures.length === 0,
    failures,
    captureManifest,
    frameGate,
    expectedRuntimeBinding,
    suppliedRuntimeBinding: canonicalRuntimeBinding,
    suppliedRuntimeBindingHash: runtimeBindingTransport.suppliedBindingHash,
    recomputedRuntimeBindingHash: runtimeBindingTransport.recomputedBindingHash,
    runtimeIdentityEvaluation,
    afterImageHash,
    swapchainSize,
    manifestImageHash,
    imageByteLength,
    manifestSession,
    manifestGateToken,
    frameSeq,
    frameTsMs,
    captureTsMs,
    requiredFrameSeq,
    requiredTsMs,
    gateIssuedAtMs,
    gateExpiresAtMs,
  };
}

function visualCaptureRuntimeBindingProjection(record, artifacts) {
  const manifestEvaluation = visualCaptureManifestEvaluation(record, artifacts);
  const pixelVerification = visualPixelVerification(artifacts);
  const deterministicVisualMode = asObject(
    record.deterministicVisualMode ?? record.deterministic_visual_mode,
  );
  const projection = {
    schema_version: GPU_HMR_VISUAL_CAPTURE_RUNTIME_BINDING_SCHEMA_VERSION,
    proof_authority: GPU_HMR_VISUAL_CAPTURE_RUNTIME_BINDING_AUTHORITY,
    proof_ledger_id: canonicalLedgerProofId(canonicalLedgerRecordProofMaterial(record)),
    runtime_binding: manifestEvaluation.expectedRuntimeBinding,
    capture_manifest_hash: manifestEvaluation.captureManifest
      ? `sha256:${sha256Hex(stableJson(manifestEvaluation.captureManifest))}`
      : null,
    capture_event_id: firstText(
      manifestEvaluation.captureManifest?.capture_event_id,
      manifestEvaluation.captureManifest?.captureEventId,
    ),
    frame_event_id: firstText(
      manifestEvaluation.captureManifest?.frame_event_id,
      manifestEvaluation.captureManifest?.frameEventId,
    ),
    capture_session_id: manifestEvaluation.manifestSession,
    gate_token_hash: manifestEvaluation.manifestGateToken
      ? `sha256:${sha256Hex(manifestEvaluation.manifestGateToken)}`
      : null,
    frame_seq: manifestEvaluation.frameSeq,
    frame_ts: { clock: 'unix_epoch_ms', value: manifestEvaluation.frameTsMs },
    capture_ts: { clock: 'unix_epoch_ms', value: manifestEvaluation.captureTsMs },
    gate_issued_ts: { clock: 'unix_epoch_ms', value: manifestEvaluation.gateIssuedAtMs },
    gate_expires_ts: { clock: 'unix_epoch_ms', value: manifestEvaluation.gateExpiresAtMs },
    required_frame_seq: manifestEvaluation.requiredFrameSeq,
    required_frame_ts: { clock: 'unix_epoch_ms', value: manifestEvaluation.requiredTsMs },
    image_hash: manifestEvaluation.manifestImageHash,
    image_byte_length: manifestEvaluation.imageByteLength,
    source_frame_hash: canonicalSha256(firstText(
      manifestEvaluation.captureManifest?.source_frame_hash,
      manifestEvaluation.captureManifest?.sourceFrameHash,
    )),
    broker_frame_hash: canonicalSha256(firstText(
      manifestEvaluation.captureManifest?.broker_frame_hash,
      manifestEvaluation.captureManifest?.brokerFrameHash,
    )),
    before_image_hash: canonicalSha256(visualArtifactHash(
      artifacts,
      pixelVerification,
      ['before_image_hash', 'beforeImageHash'],
      ['before_image_hash', 'beforeImageHash'],
    )),
    after_image_hash: manifestEvaluation.afterImageHash,
    diff_image_hash: canonicalSha256(visualArtifactHash(
      artifacts,
      pixelVerification,
      ['diff_image_hash', 'diffImageHash'],
      ['diff_image_hash', 'diffImageHash'],
    )),
    camera_state_hash: canonicalSha256(artifactFieldText(
      artifacts,
      'camera_state_hash',
      'cameraStateHash',
    )),
    capture_backend: artifactFieldText(artifacts, 'capture_backend', 'captureBackend'),
    swapchain_size: manifestEvaluation.swapchainSize,
    presentation_boundary_proven:
      objectFieldValue(deterministicVisualMode, [
        'frame_capture_after_epoch_dispatch',
        'frameCaptureAfterEpochDispatch',
      ]) === true
      && objectFieldValue(deterministicVisualMode, [
        'presentation_fence_or_frame_boundary',
        'presentationFenceOrFrameBoundary',
      ]) === true,
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    can_satisfy_runtime_proof: false,
    can_satisfy_dispatch_proof: false,
  };
  const missingFields = Object.entries(projection)
    .filter(([key, value]) => {
      if (key === 'presentation_boundary_proven') return false;
      if (key === 'swapchain_size') return !Array.isArray(value) || value.length !== 2;
      if (key === 'runtime_binding') {
        return missingVisualFrameGateRuntimeBindingFields(value).length > 0;
      }
      if (['frame_ts', 'capture_ts', 'gate_issued_ts', 'gate_expires_ts', 'required_frame_ts']
        .includes(key)) {
        return !firstText(value?.clock) || finiteNumber(value?.value) === null;
      }
      if ([
        'accepted_for_gpu_hmr',
        'gpu_hmr_success',
        'can_satisfy_runtime_proof',
        'can_satisfy_dispatch_proof',
      ].includes(key)) return value !== false;
      return value === null || value === undefined || value === '';
    })
    .map(([key]) => key);
  return { projection, missingFields, manifestEvaluation };
}

function buildVisualCaptureRuntimeBindingFromNormalizedRecord(record, artifacts) {
  const { projection, missingFields, manifestEvaluation } =
    visualCaptureRuntimeBindingProjection(record, artifacts);
  if (missingFields.length > 0 || !manifestEvaluation.accepted) {
    const failureCodes = manifestEvaluation.failures.map(({ code }) => code);
    throw new Error(
      `visual_capture_runtime_binding_material_incomplete:${[
        ...missingFields,
        ...failureCodes,
      ].join(',')}`,
    );
  }
  return Object.freeze({
    ...projection,
    binding_hash: `sha256:${sha256Hex(stableJson(projection))}`,
  });
}

export function buildGpuHmrVisualCaptureRuntimeBinding(input = {}, options = {}) {
  const record = normalizeGpuHmrProofLedgerRecord(input);
  const artifacts = mergeVisualOracleArtifactOverlay(
    visualOracleArtifacts(record.oracleArtifacts, record.outputEvent),
    visualOracleArtifactOverlay(options),
  );
  if (!artifacts) throw new Error('visual_capture_runtime_binding_artifacts_missing');
  return buildVisualCaptureRuntimeBindingFromNormalizedRecord(record, artifacts);
}

function evaluateVisualCaptureRuntimeBinding(record, artifacts) {
  const failures = [];
  const supplied = visualCaptureRuntimeBindingObject(artifacts);
  const { projection, missingFields, manifestEvaluation } =
    visualCaptureRuntimeBindingProjection(record, artifacts);
  failures.push(...manifestEvaluation.failures);
  if (!supplied) failures.push({ code: 'visual_capture_runtime_binding_missing' });
  if (missingFields.length > 0) {
    failures.push({
      code: 'visual_capture_runtime_binding_material_incomplete',
      missingFields,
    });
  }
  const recomputed = missingFields.length === 0 && manifestEvaluation.accepted
    ? Object.freeze({
        ...projection,
        binding_hash: `sha256:${sha256Hex(stableJson(projection))}`,
      })
    : null;
  if (supplied) {
    if (
      supplied.schema_version !== GPU_HMR_VISUAL_CAPTURE_RUNTIME_BINDING_SCHEMA_VERSION
      || supplied.proof_authority !== GPU_HMR_VISUAL_CAPTURE_RUNTIME_BINDING_AUTHORITY
    ) {
      failures.push({ code: 'visual_capture_runtime_binding_authority_invalid' });
    }
    if (
      supplied.accepted_for_gpu_hmr !== false
      || supplied.gpu_hmr_success !== false
      || supplied.can_satisfy_runtime_proof !== false
      || supplied.can_satisfy_dispatch_proof !== false
      || supplied.acceptedForGpuHmr === true
      || supplied.gpuHmrSuccess === true
      || supplied.canSatisfyRuntimeProof === true
      || supplied.canSatisfyDispatchProof === true
    ) {
      failures.push({ code: 'visual_capture_runtime_binding_success_authority_forbidden' });
    }
    const suppliedProjection = { ...supplied };
    delete suppliedProjection.binding_hash;
    const suppliedBindingHash = canonicalSha256(supplied.binding_hash);
    const recomputedSuppliedHash = `sha256:${sha256Hex(stableJson(suppliedProjection))}`;
    if (!suppliedBindingHash || suppliedBindingHash !== recomputedSuppliedHash) {
      failures.push({ code: 'visual_capture_runtime_binding_hash_mismatch' });
    }
    if (stableJson(suppliedProjection) !== stableJson(projection)) {
      failures.push({ code: 'visual_capture_runtime_binding_runtime_material_mismatch' });
    }
  }
  if (projection.presentation_boundary_proven !== true) {
    failures.push({ code: 'visual_capture_runtime_binding_presentation_boundary_unproven' });
  }
  if (
    projection.source_frame_hash === null
    || projection.broker_frame_hash === null
    || projection.source_frame_hash !== projection.broker_frame_hash
  ) {
    failures.push({ code: 'visual_capture_runtime_binding_frame_hash_invalid' });
  }
  return {
    accepted: failures.length === 0,
    failures,
    suppliedBinding: supplied,
    recomputedBinding: recomputed,
    captureManifestEvaluation: manifestEvaluation,
  };
}

export function evaluateGpuHmrVisualCaptureRuntimeBinding(input = {}, options = {}) {
  const record = normalizeGpuHmrProofLedgerRecord(input);
  const artifacts = mergeVisualOracleArtifactOverlay(
    visualOracleArtifacts(record.oracleArtifacts, record.outputEvent),
    visualOracleArtifactOverlay(options),
  );
  if (!artifacts) {
    return {
      accepted: false,
      failures: [{ code: 'visual_capture_runtime_binding_artifacts_missing' }],
      suppliedBinding: null,
      recomputedBinding: null,
    };
  }
  return evaluateVisualCaptureRuntimeBinding(record, artifacts);
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

function modelFieldText(record, snakeKey, camelKey, modelPolicy = DEFAULT_GPU_HMR_MODEL_POLICY) {
  const value = firstText(modelField(record, snakeKey, camelKey));
  if (snakeKey === 'provider') return normalizeModelProvider(value, modelPolicy);
  return value;
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
  const inheritedState = NORMALIZED_RECORD_STATE.get(record) ?? null;
  const sourceSchemaValues = aliasGroupValues(record, ['schema_version', 'schemaVersion']);
  const recordSchemaPresent = inheritedState?.recordSchemaPresent
    ?? sourceSchemaValues.length > 0;
  const recordSchemaExact =
    inheritedState?.recordSchemaExact !== false
    && sourceSchemaValues.length > 0
    && sourceSchemaValues.every(({ value }) => value === GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION);
  const portableCanonicalAliasMismatch =
    inheritedState?.portableCanonicalAliasMismatch === true
    || deepSnakeCamelAliasMismatch(record);
  const portableCanonicalNumbersSupported =
    inheritedState?.portableCanonicalNumbersSupported !== false
    && portableCanonicalJsonNumbersSupported(record);
  const recordProofIdAliasMismatch =
    inheritedState?.recordProofIdAliasMismatch === true
    || aliasGroupMismatch(record, ['proof_id', 'proofId']);
  const currentProofIds = compactStringList([record.proof_id, record.proofId]);
  const currentProofIdIsGenerated = inheritedState
    && currentProofIds.length === 1
    && currentProofIds[0] === inheritedState.generatedProofId;
  const suppliedProofIds = currentProofIdIsGenerated
    ? [...inheritedState.suppliedProofIds]
    : compactStringList([
      ...(inheritedState?.suppliedProofIds ?? []),
      ...currentProofIds,
    ]);
  const artifactAfterHash = firstText(
    record.artifact_after_hash,
    record.artifactAfterHash,
    record.changed_gpu_artifact_hash,
    record.changedGpuArtifactHash,
  );
  const artifactBeforeHash = firstText(record.artifact_before_hash, record.artifactBeforeHash);
  const loaderEvent = asObject(record.loader_event ?? record.loaderEvent);
  const epochPublishEventAliasMismatch =
    inheritedState?.epochPublishEventAliasMismatch === true
    || objectAliasMismatch(record, 'epoch_publish_event', 'epochPublishEvent');
  const epochPublishEvent = asObject(record.epoch_publish_event ?? record.epochPublishEvent);
  const epochCommitEventSnakePresent = hasOwn(record, 'epoch_commit_event');
  const epochCommitEventCamelPresent = hasOwn(record, 'epochCommitEvent');
  const epochCommitEventPresent = epochCommitEventSnakePresent || epochCommitEventCamelPresent;
  const epochCommitEvent = asObject(
    epochCommitEventSnakePresent ? record.epoch_commit_event : record.epochCommitEvent,
  );
  const epochCommitEventAliasMismatch =
    inheritedState?.epochCommitEventAliasMismatch === true
    || (
      epochCommitEventSnakePresent
      && epochCommitEventCamelPresent
      && stableJson(record.epoch_commit_event) !== stableJson(record.epochCommitEvent)
    );
  const dispatchEventAliasMismatch =
    inheritedState?.dispatchEventAliasMismatch === true
    || objectAliasMismatch(record, 'dispatch_event', 'dispatchEvent');
  const dispatchEvent = asObject(record.dispatch_event ?? record.dispatchEvent);
  const outputEventAliasMismatch =
    inheritedState?.outputEventAliasMismatch === true
    || objectAliasMismatch(record, 'output_event', 'outputEvent');
  const outputEvent = asObject(record.output_event ?? record.outputEvent);
  const outputOracleTargetDeclarationConflict =
    inheritedState?.outputOracleTargetDeclarationConflict === true
    || outputOracleTargetDeclarationMismatch(record);
  const retirementEventAliasMismatch =
    inheritedState?.retirementEventAliasMismatch === true
    || objectAliasMismatch(record, 'retirement_event', 'retirementEvent');
  const retirementEvent = asObject(record.retirement_event ?? record.retirementEvent);
  const processIdentityAliasMismatch =
    inheritedState?.processIdentityAliasMismatch === true
    || objectAliasMismatch(record, 'process_identity', 'processIdentity');
  const processIdentity = asObject(record.process_identity ?? record.processIdentity);
  const deviceIdentityAliasMismatch =
    inheritedState?.deviceIdentityAliasMismatch === true
    || objectAliasMismatch(record, 'device_identity', 'deviceIdentity');
  const deviceIdentity = asObject(record.device_identity ?? record.deviceIdentity);
  const firewallEvidenceAliasMismatch =
    inheritedState?.firewallEvidenceAliasMismatch === true
    || objectAliasMismatch(record, 'firewall_evidence', 'firewallEvidence');
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
  const proofCanonicalProfile = firstText(
    record.proof_canonical_profile,
    record.proofCanonicalProfile,
  );
  const firewallPidBefore = firewallProcessIdBefore(firewallEvidence);
  const firewallPidAfter = firewallProcessIdAfter(firewallEvidence);
  const recordAliasMismatchCodes = new Set(inheritedState?.recordAliasMismatchCodes ?? []);
  const recordAliasGroups = [
    ['record_schema_alias_mismatch', ['schema_version', 'schemaVersion']],
    ['project_id_alias_mismatch', ['project_id', 'projectId']],
    ['edit_id_alias_mismatch', ['edit_id', 'editId']],
    ['backend_alias_mismatch', ['backend', 'gpu_backend', 'gpuBackend']],
    ['contract_hash_alias_mismatch', ['contract_hash', 'contractHash']],
    ['artifact_before_hash_alias_mismatch', ['artifact_before_hash', 'artifactBeforeHash']],
    [
      'artifact_after_hash_alias_mismatch',
      [
        'artifact_after_hash',
        'artifactAfterHash',
        'changed_gpu_artifact_hash',
        'changedGpuArtifactHash',
      ],
    ],
    ['proof_canonical_profile_alias_mismatch', ['proof_canonical_profile', 'proofCanonicalProfile']],
    ['metric_clock_alias_mismatch', ['metric_clock', 'metricClock']],
    ['metric_scope_alias_mismatch', ['metric_scope', 'metricScope']],
    ['cache_state_alias_mismatch', ['cache_state', 'cacheState']],
    ['cpu_hmr_used_alias_mismatch', ['cpu_hmr_used', 'cpuHmrUsed']],
    ['full_rebuild_used_alias_mismatch', ['full_rebuild_used', 'fullRebuildUsed']],
    ['process_restarted_alias_mismatch', ['process_restarted', 'processRestarted']],
    ['record_success_alias_mismatch', ['gpu_hmr_success', 'gpuHmrSuccess']],
    ['loader_event_alias_mismatch', ['loader_event', 'loaderEvent']],
    ['oracle_artifacts_alias_mismatch', ['oracle_artifacts', 'oracleArtifacts']],
    [
      'deterministic_visual_mode_alias_mismatch',
      ['deterministic_visual_mode', 'deterministicVisualMode'],
    ],
    ['output_oracle_target_alias_mismatch', ['output_oracle_target', 'outputOracleTarget']],
    ['timing_metrics_alias_mismatch', ['timing_metrics', 'timingMetrics']],
    ['model_provenance_alias_mismatch', ['model_provenance', 'modelProvenance']],
    ['evidence_refs_alias_mismatch', ['evidence_refs', 'evidenceRefs']],
  ];
  for (const [code, keys] of recordAliasGroups) {
    if (aliasGroupMismatch(record, keys)) recordAliasMismatchCodes.add(code);
  }
  if (eventFieldAliasMismatch(firewallEvidence)) {
    recordAliasMismatchCodes.add('firewall_evidence_field_alias_mismatch');
  }
  const firewallFields = [
    ['cpu_hmr_used', ['cpu_hmr_used', 'cpuHmrUsed']],
    ['full_rebuild_used', ['full_rebuild_used', 'fullRebuildUsed']],
    ['process_restarted', ['process_restarted', 'processRestarted']],
  ];
  const firewallContradictionCodes = new Set(inheritedState?.firewallContradictionCodes ?? []);
  for (const [field, keys] of firewallFields) {
    if (aliasGroupMismatch(firewallEvidence, keys)) {
      firewallContradictionCodes.add(`firewall_${field}_alias_mismatch`);
    }
    if (
      aliasGroupPresent(record, keys)
      && aliasGroupPresent(firewallEvidence, keys)
      && stableJson(aliasGroupFirstValue(record, keys))
        !== stableJson(aliasGroupFirstValue(firewallEvidence, keys))
    ) {
      firewallContradictionCodes.add(`firewall_${field}_contradiction`);
    }
  }
  if (aliasGroupMismatch(firewallEvidence, [
    'process_id_before',
    'processIdBefore',
    'firewall_process_id_before',
    'firewallProcessIdBefore',
  ])) {
    firewallContradictionCodes.add('firewall_process_id_before_alias_mismatch');
  }
  if (aliasGroupMismatch(firewallEvidence, [
    'process_id_after',
    'processIdAfter',
    'firewall_process_id_after',
    'firewallProcessIdAfter',
  ])) {
    firewallContradictionCodes.add('firewall_process_id_after_alias_mismatch');
  }
  const nestedMetricClocks = [
    timings.metric_clock,
    timings.metricClock,
    timingMetrics.metric_clock,
    timingMetrics.metricClock,
    asObject(timings.clock_evidence).metric_clock,
    asObject(timings.clockEvidence).metricClock,
    asObject(timingMetrics.clock_evidence).metric_clock,
    asObject(timingMetrics.clockEvidence).metricClock,
  ].map(text).filter(Boolean);
  const topMetricClock = firstText(record.metric_clock, record.metricClock);
  const metricClockContradiction =
    inheritedState?.metricClockContradiction === true
    || (topMetricClock !== null && nestedMetricClocks.some((clock) => clock !== topMetricClock));
  const outputOracle = asObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
  const outputSuccessKeys = [
    'passed', 'success', 'succeeded', 'accepted', 'gpu_hmr_success', 'gpuHmrSuccess',
  ];
  const outputSuccessContradiction =
    inheritedState?.outputSuccessContradiction === true
    || (
      aliasGroupPresent(outputEvent, outputSuccessKeys)
      && aliasGroupPresent(outputOracle, outputSuccessKeys)
      && stableJson(aliasGroupFirstValue(outputEvent, outputSuccessKeys))
        !== stableJson(aliasGroupFirstValue(outputOracle, outputSuccessKeys))
    );
  const normalized = {
    schemaVersion: firstText(record.schema_version, record.schemaVersion),
    proofId: null,
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
    runtimeProofId: firstText(
      record.runtime_proof_id,
      record.runtimeProofId,
      outputEvent.runtime_proof_id,
      outputEvent.runtimeProofId,
    ),
    runtimeProofState: firstText(
      record.runtime_proof_state,
      record.runtimeProofState,
      outputEvent.runtime_proof_state,
      outputEvent.runtimeProofState,
    ),
    runtimeProofAccepted: asBool(
      record.runtime_proof_accepted
      ?? record.runtimeProofAccepted
      ?? outputEvent.runtime_proof_accepted
      ?? outputEvent.runtimeProofAccepted,
    ),
    runtimeProofObservedAtMs: finiteNumber(
      record.runtime_proof_observed_at_ms
      ?? record.runtimeProofObservedAtMs
      ?? outputEvent.runtime_proof_observed_at_ms
      ?? outputEvent.runtimeProofObservedAtMs,
    ),
    hmrObservedAtMs: finiteNumber(
      record.hmr_observed_at_ms
      ?? record.hmrObservedAtMs
      ?? outputEvent.hmr_observed_at_ms
      ?? outputEvent.hmrObservedAtMs,
    ),
    runtimeSessionId: runtimeSessionId(record),
    firewallEvidence,
    cpuHmrUsed: asBool(cpuHmrUsed.value),
    cpuHmrUsedEvidencePresent: cpuHmrUsed.present,
    fullRebuildUsed: asBool(fullRebuildUsed.value),
    fullRebuildUsedEvidencePresent: fullRebuildUsed.present,
    processRestarted: asBool(processRestarted.value),
    processRestartedEvidencePresent: processRestarted.present,
    firewallProcessIdBefore: firewallPidBefore,
    firewallProcessIdAfter: firewallPidAfter,
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
    metricClock: topMetricClock,
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
  if (proofCanonicalProfile !== null) {
    normalized.proofCanonicalProfile = proofCanonicalProfile;
  }
  if (epochCommitEventPresent) normalized.epochCommitEvent = epochCommitEvent;
  const baseProofMaterial = canonicalLedgerRecordProofMaterial(normalized);
  const visualCaptureBindingIdentity =
    normalized.proofCanonicalProfile === GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE
      ? null
      : visualCaptureRuntimeBindingProofIdentity(normalized);
  normalized.proofId = canonicalLedgerProofId(visualCaptureBindingIdentity
    ? {
        ...baseProofMaterial,
        visualCaptureRuntimeBinding: visualCaptureBindingIdentity,
      }
    : baseProofMaterial);
  NORMALIZED_RECORD_STATE.set(normalized, Object.freeze({
    generatedProofId: normalized.proofId,
    recordSchemaPresent,
    recordSchemaExact,
    suppliedProofIds: Object.freeze([...suppliedProofIds]),
    recordProofIdAliasMismatch,
    portableCanonicalAliasMismatch,
    portableCanonicalNumbersSupported,
    epochCommitEventPresent,
    epochCommitEventAliasMismatch,
    epochPublishEventAliasMismatch,
    dispatchEventAliasMismatch,
    outputEventAliasMismatch,
    retirementEventAliasMismatch,
    processIdentityAliasMismatch,
    deviceIdentityAliasMismatch,
    firewallEvidenceAliasMismatch,
    recordAliasMismatchCodes: Object.freeze([...recordAliasMismatchCodes]),
    firewallContradictionCodes: Object.freeze([...firewallContradictionCodes]),
    metricClockContradiction,
    outputSuccessContradiction,
    outputOracleTargetDeclarationConflict,
  }));
  return normalized;
}

function canonicalLedgerRecordProofMaterial(normalized) {
  const portable =
    normalized.proofCanonicalProfile === GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE;
  const material = {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    projectId: normalized.projectId,
    editId: normalized.editId,
    backend: normalized.backend,
    classification: normalized.classification,
    contractHash: normalized.contractHash,
    artifactBeforeHash: normalized.artifactBeforeHash,
    artifactAfterHash: normalized.artifactAfterHash,
    loaderEvent: normalized.loaderEvent,
    epochPublishEvent: normalized.epochPublishEvent,
    dispatchEvent: normalized.dispatchEvent,
    outputEvent: portable
      ? normalized.outputEvent
      : withoutVisualCaptureRuntimeBinding(normalized.outputEvent),
    retirementEvent: normalized.retirementEvent,
    processIdentity: normalized.processIdentity,
    deviceIdentity: normalized.deviceIdentity,
    runtimeProofId: normalized.runtimeProofId,
    runtimeProofState: normalized.runtimeProofState,
    runtimeProofAccepted: normalized.runtimeProofAccepted,
    runtimeProofObservedAtMs: normalized.runtimeProofObservedAtMs,
    hmrObservedAtMs: normalized.hmrObservedAtMs,
    runtimeSessionId: normalized.runtimeSessionId,
    oracleArtifacts: portable
      ? normalized.oracleArtifacts
      : withoutVisualCaptureRuntimeBinding(normalized.oracleArtifacts),
    deterministicVisualMode: normalized.deterministicVisualMode,
    outputOracleTarget: normalized.outputOracleTarget,
    metricClock: normalized.metricClock,
    metricScope: normalized.metricScope,
    cacheState: normalized.cacheState,
    timings: normalized.timings,
    timingMetrics: normalized.timingMetrics,
    modelProvenance: normalized.modelProvenance,
    evidenceRefs: normalized.evidenceRefs,
    cpuHmrUsed: normalized.cpuHmrUsed,
    fullRebuildUsed: normalized.fullRebuildUsed,
    processRestarted: normalized.processRestarted,
    firewallEvidence: {
      cpuHmrUsedEvidencePresent: normalized.cpuHmrUsedEvidencePresent,
      fullRebuildUsedEvidencePresent: normalized.fullRebuildUsedEvidencePresent,
      processRestartedEvidencePresent: normalized.processRestartedEvidencePresent,
      processIdBefore: normalized.firewallProcessIdBefore,
      processIdAfter: normalized.firewallProcessIdAfter,
    },
  };
  if (portable) {
    material.proofCanonicalProfile = normalized.proofCanonicalProfile;
    if (hasOwn(normalized, 'epochCommitEvent')) {
      material.epochCommitEvent = normalized.epochCommitEvent;
    }
    delete material.runtimeProofId;
    delete material.runtimeProofState;
    delete material.runtimeProofAccepted;
    delete material.runtimeProofObservedAtMs;
    delete material.hmrObservedAtMs;
    delete material.runtimeSessionId;
  }
  return material;
}

function addFailure(failures, code, detail = {}) {
  failures.push({ code, ...detail });
}

export function evaluateGpuHmrProofLedger(input = {}, options = {}) {
  const rawRecord = asObject(input);
  const requireVerifierOwnedVisualOutputState =
    options.requireVerifierOwnedVisualOutputState === true
    || options.require_verifier_owned_visual_output_state === true;
  const modelPolicy = resolveGpuHmrModelPolicy(
    options.modelPolicy,
    options.model_policy,
    rawRecord.modelPolicy,
    rawRecord.model_policy,
    asObject(rawRecord.modelProvenance ?? rawRecord.model_provenance).modelPolicy,
    asObject(rawRecord.modelProvenance ?? rawRecord.model_provenance).model_policy,
  );
  const record = normalizeGpuHmrProofLedgerRecord(input);
  const recordState = NORMALIZED_RECORD_STATE.get(record);
  const epochCommitEvent = asObject(record.epochCommitEvent);
  const proofCanonicalProfile = firstText(record.proofCanonicalProfile);
  const failures = [];
  const warnings = [];
  for (const suppliedProofId of recordState?.suppliedProofIds ?? []) {
    if (suppliedProofId !== record.proofId) {
      addFailure(failures, 'record_proof_id_mismatch', {
        suppliedProofId,
        recomputedProofId: record.proofId,
      });
    }
  }
  if (recordState?.recordProofIdAliasMismatch) {
    addFailure(failures, 'record_proof_id_alias_mismatch');
  }
  for (const code of recordState?.recordAliasMismatchCodes ?? []) {
    addFailure(failures, code);
  }
  for (const code of recordState?.firewallContradictionCodes ?? []) {
    addFailure(failures, code);
  }
  if (recordState?.metricClockContradiction) {
    addFailure(failures, 'metric_clock_nested_contradiction');
  }
  if (recordState?.outputSuccessContradiction) {
    addFailure(failures, 'output_event_success_contradiction');
  }
  if (recordState?.outputOracleTargetDeclarationConflict) {
    addFailure(failures, 'output_oracle_target_declaration_mismatch');
  }
  if (recordState?.epochCommitEventAliasMismatch) {
    addFailure(failures, 'epoch_commit_event_alias_mismatch');
  }
  if (recordState?.epochPublishEventAliasMismatch) {
    addFailure(failures, 'epoch_publish_event_alias_mismatch');
  }
  if (recordState?.dispatchEventAliasMismatch) {
    addFailure(failures, 'dispatch_event_alias_mismatch');
  }
  if (recordState?.outputEventAliasMismatch) {
    addFailure(failures, 'output_event_alias_mismatch');
  }
  if (recordState?.retirementEventAliasMismatch) {
    addFailure(failures, 'retirement_event_alias_mismatch');
  }
  if (recordState?.processIdentityAliasMismatch) {
    addFailure(failures, 'process_identity_alias_mismatch');
  }
  if (recordState?.deviceIdentityAliasMismatch) {
    addFailure(failures, 'device_identity_alias_mismatch');
  }
  if (recordState?.firewallEvidenceAliasMismatch) {
    addFailure(failures, 'firewall_evidence_alias_mismatch');
  }
  if (recordState?.recordSchemaPresent !== true || !record.schemaVersion) {
    addFailure(failures, 'record_schema_version_missing');
  } else if (recordState?.recordSchemaExact !== true) {
    addFailure(failures, 'record_schema_version_mismatch', {
      suppliedSchemaVersion: record.schemaVersion,
      expectedSchemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    });
  }
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
  const publishEventKind = firstText(
    record.epochPublishEvent.event,
    record.epochPublishEvent.event_kind,
    record.epochPublishEvent.eventKind,
    record.epochPublishEvent.kind,
  );
  const commitEventKind = firstText(
    epochCommitEvent.event,
    epochCommitEvent.event_kind,
    epochCommitEvent.eventKind,
    epochCommitEvent.kind,
  );
  const publicationId = firstText(
    record.epochPublishEvent.publication_id,
    record.epochPublishEvent.publicationId,
  );
  const commitPublicationId = firstText(
    epochCommitEvent.publication_id,
    epochCommitEvent.publicationId,
  );
  const dispatchPublicationId = firstText(
    record.dispatchEvent.publication_id,
    record.dispatchEvent.publicationId,
  );
  const candidateRegistrationId = firstText(
    record.epochPublishEvent.candidate_registration_id,
    record.epochPublishEvent.candidateRegistrationId,
  );
  const commitCandidateRegistrationId = firstText(
    epochCommitEvent.candidate_registration_id,
    epochCommitEvent.candidateRegistrationId,
  );
  const dispatchRegistrationId = firstText(
    record.dispatchEvent.dispatcher_registration_id,
    record.dispatchEvent.dispatcherRegistrationId,
  );
  const previousEpoch = firstText(
    record.epochPublishEvent.previous_epoch,
    record.epochPublishEvent.previousEpoch,
  );
  const commitPreviousEpoch = firstText(
    epochCommitEvent.previous_epoch,
    epochCommitEvent.previousEpoch,
  );
  const commitEraRecord =
    proofCanonicalProfile !== null
    || recordState?.epochCommitEventPresent === true
    || publishEventKind === 'provisional_install'
    || publicationId !== null
    || candidateRegistrationId !== null
    || dispatchPublicationId !== null
    || dispatchRegistrationId !== null;

  if (
    proofCanonicalProfile !== null
    && proofCanonicalProfile !== GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE
  ) {
    addFailure(failures, 'proof_canonical_profile_unsupported', {
      proofCanonicalProfile,
    });
  }
  if (commitEraRecord) {
    if (
      proofCanonicalProfile === GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE
      && recordState?.portableCanonicalNumbersSupported !== true
    ) {
      addFailure(failures, 'portable_canonical_number_unsupported');
    }
    if (
      proofCanonicalProfile === GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE
      && recordState?.portableCanonicalAliasMismatch === true
    ) {
      addFailure(failures, 'portable_canonical_alias_mismatch');
    }
    if (eventFieldAliasMismatch(record.loaderEvent)) {
      addFailure(failures, 'loader_event_field_alias_mismatch');
    }
    if (eventFieldAliasMismatch(record.epochPublishEvent)) {
      addFailure(failures, 'epoch_publish_event_field_alias_mismatch');
    }
    if (eventFieldAliasMismatch(epochCommitEvent)) {
      addFailure(failures, 'epoch_commit_event_field_alias_mismatch');
    }
    if (eventFieldAliasMismatch(record.dispatchEvent, 'dispatch')) {
      addFailure(failures, 'dispatch_event_field_alias_mismatch');
    }
    if (eventFieldAliasMismatch(record.outputEvent, 'output')) {
      addFailure(failures, 'output_event_field_alias_mismatch');
    }
    if (eventFieldAliasMismatch(record.retirementEvent, 'retirement')) {
      addFailure(failures, 'retirement_event_field_alias_mismatch');
    }
    if (eventFieldAliasMismatch(record.processIdentity)) {
      addFailure(failures, 'process_identity_field_alias_mismatch');
    }
    if (eventFieldAliasMismatch(record.deviceIdentity)) {
      addFailure(failures, 'device_identity_field_alias_mismatch');
    }
    const portableTimestampEvents = [
      ['loader', record.loaderEvent],
      ['epoch_publish', record.epochPublishEvent],
      ['dispatch', record.dispatchEvent],
      ['output', record.outputEvent],
      ['epoch_commit', epochCommitEvent],
      ['retirement', record.retirementEvent],
    ];
    const invalidPortableTimestampEvents = portableTimestampEvents
      .filter(([, event]) => portableMonotonicTimestamp(event) === null)
      .map(([name]) => name);
    if (invalidPortableTimestampEvents.length > 0) {
      addFailure(failures, 'portable_event_timestamp_invalid', {
        events: invalidPortableTimestampEvents,
      });
    }
    if (proofCanonicalProfile !== GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE) {
      addFailure(failures, 'epoch_commit_canonical_profile_missing');
    }
    if (recordState?.epochCommitEventPresent !== true || Object.keys(epochCommitEvent).length === 0) {
      addFailure(failures, 'epoch_commit_event_missing');
    }
    if (publishEventKind !== 'provisional_install') {
      addFailure(failures, 'epoch_publish_event_not_provisional');
    }
    if (commitEventKind !== 'unrestricted_visibility_commit') {
      addFailure(failures, 'epoch_commit_event_kind_invalid');
    }
    if (!eventId(epochCommitEvent)) addFailure(failures, 'epoch_commit_event_id_missing');
    if (!publicationId) addFailure(failures, 'epoch_publication_id_missing');
    if (!candidateRegistrationId) addFailure(failures, 'epoch_candidate_registration_id_missing');
    if (publicationId && commitPublicationId !== publicationId) {
      addFailure(failures, 'epoch_commit_publication_id_mismatch');
    }
    if (publicationId && dispatchPublicationId !== publicationId) {
      addFailure(failures, 'dispatch_publication_id_mismatch');
    }
    if (
      candidateRegistrationId
      && commitCandidateRegistrationId !== candidateRegistrationId
    ) {
      addFailure(failures, 'epoch_commit_candidate_registration_id_mismatch');
    }
    if (candidateRegistrationId && dispatchRegistrationId !== candidateRegistrationId) {
      addFailure(failures, 'dispatch_registration_id_mismatch');
    }
    const commitArtifactHash = eventArtifactHash(epochCommitEvent);
    if (!commitArtifactHash) {
      addFailure(failures, 'epoch_commit_artifact_hash_missing');
    } else if (artifactAfterHash && commitArtifactHash !== artifactAfterHash) {
      addFailure(failures, 'epoch_commit_artifact_hash_mismatch');
    }
    const commitEpoch = eventEpoch(epochCommitEvent);
    if (!commitEpoch) {
      addFailure(failures, 'epoch_commit_epoch_missing');
    } else if (publishedEpoch && commitEpoch !== publishedEpoch) {
      addFailure(failures, 'epoch_commit_epoch_mismatch');
    }
    if (!previousEpoch) addFailure(failures, 'epoch_previous_epoch_missing');
    const rawPreviousGeneration = rawPreviousEpoch(record.epochPublishEvent);
    const rawCandidateGeneration = rawEventEpoch(record.epochPublishEvent);
    const commitEraEpochs = [
      ['previous_epoch', rawPreviousGeneration],
      ['published_epoch', rawCandidateGeneration],
      ['commit_epoch', rawEventEpoch(epochCommitEvent)],
      ['commit_previous_epoch', rawPreviousEpoch(epochCommitEvent)],
      ['dispatch_epoch', rawEventEpoch(record.dispatchEvent)],
      ['output_epoch', rawEventEpoch(record.outputEvent)],
      ['retirement_epoch', rawEventEpoch(record.retirementEvent)],
    ];
    const nonCanonicalEpochs = commitEraEpochs
      .filter(([, epoch]) => epoch !== undefined && epoch !== null
        && canonicalDecimalEpoch(epoch) === null)
      .map(([field, epoch]) => ({ field, epoch }));
    if (nonCanonicalEpochs.length > 0) {
      addFailure(failures, 'epoch_generation_not_canonical_decimal', {
        fields: nonCanonicalEpochs,
      });
    }
    if (
      rawPreviousGeneration !== undefined
      && rawCandidateGeneration !== undefined
      && !forwardEpochTransition(rawPreviousGeneration, rawCandidateGeneration)
    ) {
      addFailure(failures, 'epoch_generation_transition_not_forward', {
        previousEpoch: rawPreviousGeneration,
        candidateEpoch: rawCandidateGeneration,
      });
    }
    if (previousEpoch && commitPreviousEpoch !== previousEpoch) {
      addFailure(failures, 'epoch_commit_previous_epoch_mismatch');
    }
    const retirementEpoch = eventEpoch(record.retirementEvent);
    if (previousEpoch && retirementEpoch !== previousEpoch) {
      addFailure(failures, 'retirement_epoch_mismatch');
    }
    const retirementArtifactHash = eventArtifactHash(record.retirementEvent);
    if (!retirementArtifactHash) {
      addFailure(failures, 'retirement_artifact_hash_missing');
    } else if (record.artifactBeforeHash && retirementArtifactHash !== record.artifactBeforeHash) {
      addFailure(failures, 'retirement_artifact_hash_mismatch', {
        expected: record.artifactBeforeHash,
        actual: retirementArtifactHash,
      });
    }
    const retirementProof = firstText(
      record.retirementEvent.proof,
      record.retirementEvent.retirement_proof,
      record.retirementEvent.retirementProof,
    );
    if (!SUCCESSFUL_RETIREMENT_PROOFS.has(retirementProof ?? '')) {
      addFailure(failures, 'retirement_proof_not_successful', { retirementProof });
    }
    const retirementResult = firstText(
      record.retirementEvent.status,
      record.retirementEvent.result,
      record.retirementEvent.retirement_result,
      record.retirementEvent.retirementResult,
    );
    if (!SUCCESSFUL_RETIREMENT_RESULTS.has(retirementResult ?? '')) {
      addFailure(failures, 'retirement_result_not_successful', { retirementResult });
    }
    const commitPid = eventProcessId(epochCommitEvent);
    const retirementPid = eventProcessId(record.retirementEvent);
    if (!commitPid) addFailure(failures, 'epoch_commit_process_identity_missing');
    else if (identityPid && commitPid !== identityPid) {
      addFailure(failures, 'epoch_commit_process_identity_mismatch');
    }
    if (!retirementPid) addFailure(failures, 'retirement_process_identity_missing');
    else if (identityPid && retirementPid !== identityPid) {
      addFailure(failures, 'retirement_process_identity_mismatch');
    }
    const commitTs = eventTimestamp(epochCommitEvent);
    if (commitTs === null) addFailure(failures, 'epoch_commit_timestamp_missing');
    if (outputTs !== null && commitTs !== null && commitTs < outputTs) {
      addFailure(failures, 'epoch_commit_precedes_output');
    }
    if (commitTs !== null && retirementTs !== null && retirementTs < commitTs) {
      addFailure(failures, 'retirement_precedes_epoch_commit');
    }
    if (publicationId && !record.evidenceRefs.includes(`dispatcher-publication:${publicationId}`)) {
      addFailure(failures, 'epoch_publication_evidence_ref_missing');
    }
    if (
      candidateRegistrationId
      && !record.evidenceRefs.includes(`dispatcher-registration:${candidateRegistrationId}`)
    ) {
      addFailure(failures, 'epoch_registration_evidence_ref_missing');
    }
  }

  if (!record.projectId) addFailure(failures, 'project_id_missing');
  if (!record.editId) addFailure(failures, 'edit_id_missing');
  if (!record.backend) addFailure(failures, 'backend_missing');
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
  if (
    record.firewallProcessIdBefore
    && record.firewallProcessIdAfter
    && record.firewallProcessIdBefore !== record.firewallProcessIdAfter
  ) {
    addFailure(failures, 'firewall_process_identity_contradiction', {
      processIdBefore: record.firewallProcessIdBefore,
      processIdAfter: record.firewallProcessIdAfter,
    });
  }
  if (identityPid) {
    if (record.firewallProcessIdBefore && record.firewallProcessIdBefore !== identityPid) {
      addFailure(failures, 'firewall_process_identity_before_mismatch', {
        processIdBefore: record.firewallProcessIdBefore,
        processIdentity: identityPid,
      });
    }
    if (record.firewallProcessIdAfter && record.firewallProcessIdAfter !== identityPid) {
      addFailure(failures, 'firewall_process_identity_after_mismatch', {
        processIdAfter: record.firewallProcessIdAfter,
        processIdentity: identityPid,
      });
    }
  }
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
  const outputOracleKind = outputKind(record.outputEvent);
  if (!outputOracleKind) addFailure(failures, 'output_oracle_kind_missing');
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
  const visualArtifacts = mergeVisualOracleArtifactOverlay(
    visualOracleArtifacts(record.oracleArtifacts, record.outputEvent),
    visualOracleArtifactOverlay(options),
  );
  const computeArtifacts = mergeComputeOracleArtifactOverlay(
    computeOracleArtifacts(record.oracleArtifacts, record.outputEvent),
    computeOracleArtifactOverlay(options),
  );
  const target = asObject(record.outputOracleTarget);
  const targetModality = outputOracleTargetModality(target);
  const targetId = outputOracleTargetId(target);
  const observedTargetId = outputEventTargetId(record.outputEvent);
  const targetEvidenceRefs = outputOracleTargetEvidenceRefs(target);
  const unresolvedTargetEvidenceRefs = targetEvidenceRefs.filter(
    (evidenceRef) => !record.evidenceRefs.includes(evidenceRef),
  );
  const verifierAvailable = targetModality === 'visual' || targetModality === 'compute';
  const visualOutput = targetModality === 'visual';
  const visualCaptureRuntimeBindingRequired =
    options.requireVisualCaptureRuntimeBinding === true
    || options.require_visual_capture_runtime_binding === true;
  let visualCaptureRuntimeBindingEvaluation = null;
  if (!targetModality) {
    addFailure(failures, 'output_oracle_target_modality_missing');
  } else {
    if (!verifierAvailable) {
      addFailure(failures, 'output_oracle_target_verifier_missing', { targetModality });
    } else if (targetModality === 'visual' && !visualArtifacts) {
      addFailure(failures, 'visual_output_target_requires_visual_oracle');
    } else if (targetModality === 'compute' && !computeArtifacts) {
      addFailure(failures, 'compute_output_target_requires_compute_oracle');
    }
  }
  if (!targetId) addFailure(failures, 'output_oracle_target_id_missing');
  if (!observedTargetId) {
    addFailure(failures, 'output_event_target_id_missing');
  } else if (targetId && observedTargetId !== targetId) {
    addFailure(failures, 'output_oracle_target_id_mismatch', {
      expected: targetId,
      actual: observedTargetId,
    });
  }
  if (targetEvidenceRefs.length === 0) {
    addFailure(failures, 'output_oracle_target_evidence_refs_missing');
  } else if (unresolvedTargetEvidenceRefs.length > 0) {
    addFailure(failures, 'output_oracle_target_evidence_refs_unresolved', {
      unresolvedEvidenceRefs: unresolvedTargetEvidenceRefs,
    });
  }
  if (visualOutput) {
    const artifacts = visualArtifacts;
    if (!artifacts) {
      addFailure(failures, 'visual_oracle_artifacts_missing');
    } else {
      const suppliedVisualCaptureBinding = visualCaptureRuntimeBindingObject(artifacts);
      if (visualCaptureRuntimeBindingRequired || suppliedVisualCaptureBinding) {
        visualCaptureRuntimeBindingEvaluation = evaluateVisualCaptureRuntimeBinding(
          record,
          artifacts,
        );
        for (const failure of visualCaptureRuntimeBindingEvaluation.failures) {
          addFailure(failures, failure.code, failure);
        }
      } else {
        warnings.push({ code: 'visual_capture_runtime_binding_legacy_missing' });
      }
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
      const cameraStateValue = objectFieldValue(artifacts, [
        'camera_state_hash',
        'cameraStateHash',
      ]);
      const cameraStateHash = artifactFieldText(artifacts, 'camera_state_hash', 'cameraStateHash');
      const canonicalCameraStateHash = canonicalSha256(cameraStateHash);
      if (cameraStateValue !== undefined && cameraStateValue !== null) {
        if (!canonicalCameraStateHash) {
          addFailure(failures, 'visual_camera_state_hash_invalid');
        }
      }
      const swapchainSizeValue = objectFieldValue(artifacts, [
        'swapchain_size',
        'swapchainSize',
      ]);
      const swapchainSize = artifactFieldArray(artifacts, 'swapchain_size', 'swapchainSize');
      if (
        swapchainSizeValue !== undefined
        && swapchainSizeValue !== null
        && (
          swapchainSize.length !== 2
          || !swapchainSize.every((value) => Number.isFinite(Number(value)) && Number(value) > 0)
        )
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
      evaluateGpuHmrDeterministicVisualMode({
        ...asObject(record.deterministicVisualMode),
        artifact_hash_after: artifactAfterHash,
      });
    if (deterministicVisualModeEvaluation.accepted !== true) {
      addFailure(failures, 'visual_output_without_deterministic_mode', {
        failedGates: deterministicVisualModeEvaluation.failedGates,
      });
      for (const gate of deterministicVisualModeEvaluation.failedGates) {
        addFailure(failures, gate.code ?? 'deterministic_visual_mode_gate_failed');
      }
    }
    if (requireVerifierOwnedVisualOutputState) {
      addFailure(failures, 'verifier_owned_visual_output_state_receipt_missing');
    }
  } else {
    const artifacts = computeArtifacts;
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
      const expected = modelPolicy.roles[role];
      const provider = modelFieldText(model, 'provider', 'provider', modelPolicy);
      if (!expected?.provider || !expected?.model) {
        addFailure(failures, 'model_role_policy_missing', {
          record: prefix,
          request_mode: role,
        });
        continue;
      }
      if (provider !== expected.provider) {
        addFailure(failures, 'model_provider_not_allowed', {
          record: prefix,
          request_mode: role,
          provider,
          expected_provider: expected.provider,
        });
      }
      const expectedModel = expected.model;
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
    visualCaptureRuntimeBinding: visualCaptureRuntimeBindingEvaluation,
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

export function buildGpuHmrProofLedger(input = {}, options = {}) {
  const record = normalizeGpuHmrProofLedgerRecord(input);
  const query = evaluateGpuHmrProofLedger(record, options);
  const proofId = canonicalLedgerRootProofId([record.proofId]);
  return {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId,
    records: [record],
    query: {
      ...query,
      proofId,
    },
    gpuHmrSuccess: query.gpuHmrSuccess,
    gpu_hmr_success: query.gpuHmrSuccess,
  };
}

export function queryGpuHmrLedgerInvariants(input = {}, options = {}) {
  const ledger = asObject(input);
  const ledgerSchemaValues = aliasGroupValues(ledger, ['schema_version', 'schemaVersion']);
  const ledgerSchemaVersion = firstText(ledger.schema_version, ledger.schemaVersion);
  const ledgerModelPolicy = resolveGpuHmrModelPolicy(ledger.modelPolicy, ledger.model_policy);
  const ignoreSuppliedLedgerQueryAndSuccess = options.ignoreSuppliedLedgerQueryAndSuccess === true
    || options.ignore_supplied_ledger_query_and_success === true;
  const recordsFieldPresent = hasOwn(ledger, 'records');
  const records = Array.isArray(ledger.records) ? ledger.records : null;
  const invalidRecordResult = (code) => ({
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId: null,
    gpuHmrSuccess: false,
    failedInvariants: [{ code }],
    warnings: [],
    record: null,
    invariantSummary: {},
  });
  const evaluations = recordsFieldPresent
    ? records && records.length > 0
      ? records.map((record, index) => ({
        index,
        result: record && typeof record === 'object' && !Array.isArray(record)
          ? evaluateGpuHmrProofLedger(record, {
            modelPolicy: ledgerModelPolicy,
            computeOracleArtifactOverlay: computeOracleArtifactOverlay(options, index),
            visualOracleArtifactOverlay: visualOracleArtifactOverlay(options, index),
            requireVisualCaptureRuntimeBinding:
              options.requireVisualCaptureRuntimeBinding === true
              || options.require_visual_capture_runtime_binding === true,
            requireVerifierOwnedVisualOutputState:
              options.requireVerifierOwnedVisualOutputState === true
              || options.require_verifier_owned_visual_output_state === true,
          })
          : invalidRecordResult('ledger_record_not_object'),
      }))
      : [{ index: 0, result: invalidRecordResult('ledger_record_unavailable') }]
    : [{
      index: 0,
      result: evaluateGpuHmrProofLedger(input, {
        modelPolicy: ledgerModelPolicy,
        computeOracleArtifactOverlay: computeOracleArtifactOverlay(options, 0),
        visualOracleArtifactOverlay: visualOracleArtifactOverlay(options, 0),
        requireVisualCaptureRuntimeBinding:
          options.requireVisualCaptureRuntimeBinding === true
          || options.require_visual_capture_runtime_binding === true,
        requireVerifierOwnedVisualOutputState:
          options.requireVerifierOwnedVisualOutputState === true
          || options.require_verifier_owned_visual_output_state === true,
      }),
    }];
  const recomputed = evaluations[evaluations.length - 1].result;
  const proofId = recordsFieldPresent && records && records.length > 0
    ? canonicalLedgerRootProofId(evaluations.map(({ result }) => result.proofId))
    : recomputed.proofId;
  const failures = evaluations.flatMap(({ index, result }) =>
    result.failedInvariants.map((failure) => ({
      ...failure,
      record_index: failure.record_index ?? index,
    }))
  );
  if (aliasGroupMismatch(ledger, ['schema_version', 'schemaVersion'])) {
    failures.push({ code: 'ledger_schema_alias_mismatch' });
  }
  if (ledgerSchemaValues.length === 0 || !ledgerSchemaVersion) {
    failures.push({ code: 'ledger_schema_version_missing' });
  } else if (!ledgerSchemaValues.every(
    ({ value }) => value === GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
  )) {
    failures.push({
      code: 'ledger_schema_version_mismatch',
      suppliedSchemaVersion: ledgerSchemaVersion,
      expectedSchemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    });
  }
  if (recordsFieldPresent && records === null) {
    failures.push({ code: 'ledger_records_not_array' });
  } else if (records && records.length === 0) {
    failures.push({ code: 'ledger_records_empty' });
  }
  if (records && records.length > 1) {
    const recordProofIds = evaluations.map(({ result }) => result.proofId).filter(Boolean);
    if (new Set(recordProofIds).size !== recordProofIds.length) {
      failures.push({ code: 'ledger_record_proof_ids_duplicate' });
    }
  }
  const recordSuccess = failures.length === 0;
  if (objectAliasMismatch(ledger, 'proof_id', 'proofId')) {
    failures.push({ code: 'ledger_proof_id_alias_mismatch' });
  }
  const topLevelProofId = firstText(ledger.proofId, ledger.proof_id);
  if (topLevelProofId && topLevelProofId !== proofId) {
    failures.push({
      code: 'ledger_proof_id_mismatch',
      suppliedProofId: topLevelProofId,
      recomputedProofId: proofId,
    });
  }
  const topLevelSuccess = firstPresent(
    [ledger, 'gpuHmrSuccess'],
    [ledger, 'gpu_hmr_success'],
  );
  if (aliasGroupMismatch(ledger, ['gpu_hmr_success', 'gpuHmrSuccess'])) {
    failures.push({ code: 'ledger_success_flag_alias_mismatch' });
  }
  if (
    !ignoreSuppliedLedgerQueryAndSuccess
    && (
    topLevelSuccess.present
    && topLevelSuccess.value !== recordSuccess
    )
  ) {
    failures.push({
      code: 'ledger_success_flag_mismatch',
      suppliedGpuHmrSuccess: topLevelSuccess.value,
      recomputedGpuHmrSuccess: recordSuccess,
    });
  }
  const suppliedQuery = asObject(ledger.query);
  const suppliedQuerySchemaValues = aliasGroupValues(
    suppliedQuery,
    ['schema_version', 'schemaVersion'],
  );
  const suppliedQuerySchemaExact = suppliedQuerySchemaValues.length > 0
    && suppliedQuerySchemaValues.every(
      ({ value }) => value === GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    );
  if (aliasGroupMismatch(suppliedQuery, ['schema_version', 'schemaVersion'])) {
    failures.push({ code: 'supplied_ledger_query_schema_alias_mismatch' });
  }
  if (aliasGroupMismatch(suppliedQuery, ['gpu_hmr_success', 'gpuHmrSuccess'])) {
    failures.push({ code: 'supplied_ledger_query_success_alias_mismatch' });
  }
  if (
    !ignoreSuppliedLedgerQueryAndSuccess
    && objectAliasMismatch(suppliedQuery, 'proof_id', 'proofId')
  ) {
    failures.push({ code: 'supplied_ledger_query_proof_id_alias_mismatch' });
  }
  if (
    !ignoreSuppliedLedgerQueryAndSuccess
    && suppliedQuerySchemaExact
  ) {
    const suppliedFailures = compactStringList(
      Array.isArray(suppliedQuery.failedInvariants)
        ? suppliedQuery.failedInvariants.map((failure) => asObject(failure).code)
        : [],
    ).sort();
    const recomputedFailures = compactStringList(failures.map((failure) => failure.code)).sort();
    const suppliedQuerySuccess = firstPresent(
      [suppliedQuery, 'gpuHmrSuccess'],
      [suppliedQuery, 'gpu_hmr_success'],
    );
    const suppliedConsistent =
      suppliedQuerySuccess.present
      && typeof suppliedQuerySuccess.value === 'boolean'
      && suppliedQuerySuccess.value === recordSuccess
      && firstText(suppliedQuery.proofId, suppliedQuery.proof_id) === proofId
      && stableJson(suppliedFailures) === stableJson(recomputedFailures);
    if (!suppliedConsistent) {
      return {
        ...recomputed,
        proofId,
        gpuHmrSuccess: false,
        failedInvariants: [
          ...failures,
          {
            code: 'supplied_ledger_query_mismatch',
            suppliedGpuHmrSuccess: suppliedQuerySuccess.present
              ? suppliedQuerySuccess.value
              : null,
            recomputedGpuHmrSuccess: recordSuccess,
          },
        ],
      };
    }
  } else if (!ignoreSuppliedLedgerQueryAndSuccess && Object.keys(suppliedQuery).length > 0) {
    failures.push({
      code: 'supplied_ledger_query_schema_mismatch',
      suppliedSchemaVersion: suppliedQuery.schemaVersion ?? suppliedQuery.schema_version ?? null,
    });
  }
  return {
    ...recomputed,
    proofId,
    gpuHmrSuccess: failures.length === 0,
    failedInvariants: failures,
  };
}

export function buildGpuHmrRunModeCoverageSupport({
  proofLedger = null,
  proofLedgerQuery = null,
  runtimeProofArtifact = null,
  parentProofIds = [],
  runMode = null,
  runModeProofIds = [],
} = {}) {
  const runtimeArtifact = asObject(runtimeProofArtifact);
  const runModeRecord = asObject(runMode);
  const runModeMetricScope = firstText(
    runModeRecord.metricScope,
    runModeRecord.metric_scope,
  );
  const runModeEditHash = firstText(
    runModeRecord.editHash,
    runModeRecord.edit_hash,
  );
  const embeddedLedger = proofLedger ?? runtimeArtifact.proofLedger ?? runtimeArtifact.proof_ledger;
  const ledger = asObject(embeddedLedger);
  const suppliedQuery = asObject(proofLedgerQuery);
  const recomputed = Object.keys(suppliedQuery).length > 0
    ? suppliedQuery
    : Object.keys(ledger).length > 0
      ? queryGpuHmrLedgerInvariants(ledger)
      : {};
  const failedInvariants = Array.isArray(recomputed.failedInvariants)
    ? recomputed.failedInvariants
    : [];
  const proofLedgerSuccess =
    recomputed.gpuHmrSuccess === true
    && failedInvariants.length === 0;
  const runtimeProofArtifactGpuHmrSuccess =
    runtimeArtifact.gpuHmrSuccess === true
    || runtimeArtifact.gpu_hmr_success === true;
  const runtimeProofArtifactFullRuntimeProven =
    runtimeArtifact.fullRuntimeProven === true
    || runtimeArtifact.full_runtime_proven === true;
  const record = asObject(
    recomputed.record
      ?? recomputed.ledgerRecord
      ?? recomputed.ledger_record
      ?? (Array.isArray(ledger.records) ? ledger.records[ledger.records.length - 1] : null)
      ?? ledger.record
      ?? ledger,
  );
  const contractHash = firstText(record.contractHash, record.contract_hash);
  const artifactAfterHash = firstText(record.artifactAfterHash, record.artifact_after_hash);
  if (!contractHash || !artifactAfterHash) return null;
  const artifactBeforeHash = firstText(record.artifactBeforeHash, record.artifact_before_hash);
  const proofLedgerId = firstText(
    recomputed.proofId,
    recomputed.proof_id,
    ledger.proofId,
    ledger.proof_id,
    record.proofId,
    record.proof_id,
  );
  const linkedParentProofIds = [...new Set(compactStringList([
    ...parentProofIds,
    recomputed.proofId,
    recomputed.proof_id,
    ledger.proofId,
    ledger.proof_id,
    record.proofId,
    record.proof_id,
    runtimeArtifact.proofId,
    runtimeArtifact.proof_id,
  ]))];
  const linkedRunModeProofIds = [...new Set(compactStringList(runModeProofIds))];
  return {
    schemaVersion: 'synthi.gpu.hmr.run_mode_coverage_support.v1',
    schema_version: 'synthi.gpu.hmr.run_mode_coverage_support.v1',
    parentProofIds: linkedParentProofIds,
    parent_proof_ids: linkedParentProofIds,
    contractHash,
    contract_hash: contractHash,
    artifactBeforeHash,
    artifact_before_hash: artifactBeforeHash,
    artifactAfterHash,
    artifact_after_hash: artifactAfterHash,
    runModeMetricScope,
    run_mode_metric_scope: runModeMetricScope,
    runModeEditHash,
    run_mode_edit_hash: runModeEditHash,
    runModeProofIds: linkedRunModeProofIds,
    run_mode_proof_ids: linkedRunModeProofIds,
    proofLedgerSuccess,
    proof_ledger_success: proofLedgerSuccess,
    proofLedgerId: proofLedgerId ?? null,
    proof_ledger_id: proofLedgerId ?? null,
    runtimeProofArtifactGpuHmrSuccess,
    runtime_proof_artifact_gpu_hmr_success: runtimeProofArtifactGpuHmrSuccess,
    runtimeProofArtifactFullRuntimeProven,
    runtime_proof_artifact_full_runtime_proven: runtimeProofArtifactFullRuntimeProven,
  };
}

export function bindGpuHmrRunModeCoverageSupport(support, {
  runMode = null,
  proofIds = [],
} = {}) {
  const source = asObject(support);
  if (Object.keys(source).length === 0) return null;
  const runModeRecord = asObject(runMode);
  const runModeMetricScope = firstText(
    runModeRecord.metricScope,
    runModeRecord.metric_scope,
    source.runModeMetricScope,
    source.run_mode_metric_scope,
  );
  const runModeEditHash = firstText(
    runModeRecord.editHash,
    runModeRecord.edit_hash,
    source.runModeEditHash,
    source.run_mode_edit_hash,
  );
  const linkedRunModeProofIds = [...new Set(compactStringList([
    ...(Array.isArray(source.runModeProofIds) ? source.runModeProofIds : []),
    ...(Array.isArray(source.run_mode_proof_ids) ? source.run_mode_proof_ids : []),
    ...proofIds,
  ]))];
  return {
    ...source,
    runModeMetricScope,
    run_mode_metric_scope: runModeMetricScope,
    runModeEditHash,
    run_mode_edit_hash: runModeEditHash,
    runModeProofIds: linkedRunModeProofIds,
    run_mode_proof_ids: linkedRunModeProofIds,
  };
}

export function assertGpuHmrProofLedgerSuccess(input = {}) {
  const result = queryGpuHmrLedgerInvariants(input);
  if (!result.gpuHmrSuccess) {
    const codes = result.failedInvariants.map((failure) => failure.code).join(',');
    throw new Error(`GPU HMR proof ledger rejected record: ${codes}`);
  }
  return result;
}
