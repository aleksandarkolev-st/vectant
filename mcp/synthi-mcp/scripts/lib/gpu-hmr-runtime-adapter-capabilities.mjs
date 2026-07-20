import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import { classifyGpuHmrOutputOracleKind } from './gpu-hmr-output-oracle-kind.mjs';

export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_adapter_capabilities.v1';
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_AUTHORITY =
  'runtime_adapter_capability_obligations_only_not_gpu_hmr_success';
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_INTEGRITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_adapter_capabilities_integrity.v1';
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_INTEGRITY_AUTHORITY =
  'runtime_adapter_capability_integrity_only_not_gpu_hmr_success';

export const GPU_HMR_RUNTIME_ADAPTER_ARTIFACT_FORMATS = Object.freeze([
  'native_binary',
  'portable_ir',
  'runtime_source',
  'engine_asset',
  'opaque_payload',
]);

export const GPU_HMR_RUNTIME_ADAPTER_OUTPUT_MODALITIES = Object.freeze([
  'compute',
  'visual',
]);

export const GPU_HMR_RUNTIME_ADAPTER_PUBLICATION_MODELS = Object.freeze([
  'dispatch_table_epoch',
  'pipeline_object_epoch',
  'engine_managed_epoch',
  'opaque_callback_epoch',
]);

export const GPU_HMR_RUNTIME_ADAPTER_COMMAND_RECORDING_MODELS = Object.freeze([
  'late_bound_dispatch',
  'record_after_publication',
  'pre_recorded_commands',
  'opaque_engine_managed',
]);

export const GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OWNERS = Object.freeze([
  'none',
  'adapter',
  'application',
  'runtime',
  'engine',
  'opaque_external',
]);

export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS = Object.freeze([
  'artifactFormat',
  'outputModality',
  'oracleKind',
  'publicationModel',
  'commandRecordingModel',
  'pipelineCacheOwner',
  'evidenceRefs',
]);

export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS = Object.freeze(
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS.filter(
    (field) => field !== 'evidenceRefs',
  ),
);

export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_OBLIGATIONS = Object.freeze({
  verifiedArtifactTransport: 'verified_artifact_transport',
  changedArtifactLoadIntoTargetProcess: 'changed_artifact_load_into_target_process',
  epochPublication: 'epoch_publication',
  loadedArtifactEpochBinding: 'loaded_artifact_epoch_binding',
  postPublicationDispatch: 'post_publication_dispatch',
  dispatchEpochArtifactBinding: 'dispatch_epoch_artifact_binding',
  sameProcessHostIdentity: 'same_process_host_identity',
  outputAfterDispatchOracleBinding: 'output_after_dispatch_oracle_binding',
  retirementSafety: 'retirement_safety',
  abiCompatibility: 'abi_compatibility',
  cpuHmrFullRebuildRestartFirewall: 'cpu_hmr_full_rebuild_restart_firewall',
  runtimeCompilerSourceToArtifactProof: 'runtime_compiler_source_to_artifact_proof',
  explicitAppHookContract: 'explicit_app_hook_contract',
  runtimeBoundaryEvidence: 'runtime_boundary_evidence',
  computeRawReadbackBytes: 'compute_raw_readback_bytes',
  computeReadbackSchema: 'compute_readback_schema',
  computeBeforeAfterChecksum: 'compute_before_after_checksum',
  computeDeterministicSlice: 'compute_deterministic_slice',
  visualVerifiedBeforeBytes: 'visual_verified_before_bytes',
  visualVerifiedAfterBytes: 'visual_verified_after_bytes',
  visualVerifiedDiffBytes: 'visual_verified_diff_bytes',
  visualDeterministicControls: 'visual_deterministic_controls',
  visualPostEpochFrameBoundary: 'visual_post_epoch_frame_boundary',
  visualBlankFrameRejection: 'visual_blank_frame_rejection',
  visualStaleFrameRejection: 'visual_stale_frame_rejection',
  visualJitterRejection: 'visual_jitter_rejection',
  visualTemporalEffectRejection: 'visual_temporal_effect_rejection',
  pipelineRecreation: 'pipeline_recreation',
  pipelineIdentityEpochBinding: 'pipeline_identity_epoch_binding',
  postPublicationCommandRecording: 'post_publication_command_recording',
  oldCommandInvalidation: 'old_command_invalidation',
  oldCommandRetirement: 'old_command_retirement',
  postPublicationCommandRerecord: 'post_publication_command_rerecord',
  newRecordingChangedArtifactProof: 'new_recording_changed_artifact_proof',
});

export const GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS = Object.freeze({
  none: Object.freeze([
    'pipeline_cache_none_refresh_absence_proof',
    'pipeline_cache_none_invalidation_absence_proof',
    'pipeline_cache_none_identity_absence_binding',
  ]),
  adapter: Object.freeze([
    'pipeline_cache_adapter_refresh_proof',
    'pipeline_cache_adapter_invalidation_proof',
    'pipeline_cache_adapter_identity_binding',
  ]),
  application: Object.freeze([
    'pipeline_cache_application_refresh_proof',
    'pipeline_cache_application_invalidation_proof',
    'pipeline_cache_application_identity_binding',
  ]),
  runtime: Object.freeze([
    'pipeline_cache_runtime_refresh_proof',
    'pipeline_cache_runtime_invalidation_proof',
    'pipeline_cache_runtime_identity_binding',
  ]),
  engine: Object.freeze([
    'pipeline_cache_engine_refresh_proof',
    'pipeline_cache_engine_invalidation_proof',
    'pipeline_cache_engine_identity_binding',
  ]),
  opaque_external: Object.freeze([
    'pipeline_cache_opaque_external_refresh_proof',
    'pipeline_cache_opaque_external_invalidation_proof',
    'pipeline_cache_opaque_external_identity_binding',
  ]),
});

export const GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REFS = 64;
export const GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REF_BYTES = 1024;
export const GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REFS_BYTES = 32 * 1024;

const INPUT_FIELD_SET = new Set(GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS);
const CAPABILITY_FACT_FIELD_SET = new Set(
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS,
);
const ARTIFACT_FORMAT_SET = new Set(GPU_HMR_RUNTIME_ADAPTER_ARTIFACT_FORMATS);
const OUTPUT_MODALITY_SET = new Set(GPU_HMR_RUNTIME_ADAPTER_OUTPUT_MODALITIES);
const PUBLICATION_MODEL_SET = new Set(GPU_HMR_RUNTIME_ADAPTER_PUBLICATION_MODELS);
const COMMAND_RECORDING_MODEL_SET = new Set(
  GPU_HMR_RUNTIME_ADAPTER_COMMAND_RECORDING_MODELS,
);
const PIPELINE_CACHE_OWNER_SET = new Set(GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OWNERS);
const CAPABILITY_FACET_FIELDS = Object.freeze([
  'schemaVersion',
  'authority',
  ...GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS,
  'obligations',
  'capabilitiesHash',
  'obligationsHash',
  'bindingHash',
  'proofId',
  'valid',
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]);
const CAPABILITY_FACET_FIELD_SET = new Set(CAPABILITY_FACET_FIELDS);

const {
  verifiedArtifactTransport,
  changedArtifactLoadIntoTargetProcess,
  epochPublication,
  loadedArtifactEpochBinding,
  postPublicationDispatch,
  dispatchEpochArtifactBinding,
  sameProcessHostIdentity,
  outputAfterDispatchOracleBinding,
  retirementSafety,
  abiCompatibility,
  cpuHmrFullRebuildRestartFirewall,
  runtimeCompilerSourceToArtifactProof,
  explicitAppHookContract,
  runtimeBoundaryEvidence,
  computeRawReadbackBytes,
  computeReadbackSchema,
  computeBeforeAfterChecksum,
  computeDeterministicSlice,
  visualVerifiedBeforeBytes,
  visualVerifiedAfterBytes,
  visualVerifiedDiffBytes,
  visualDeterministicControls,
  visualPostEpochFrameBoundary,
  visualBlankFrameRejection,
  visualStaleFrameRejection,
  visualJitterRejection,
  visualTemporalEffectRejection,
  pipelineRecreation,
  pipelineIdentityEpochBinding,
  postPublicationCommandRecording,
  oldCommandInvalidation,
  oldCommandRetirement,
  postPublicationCommandRerecord,
  newRecordingChangedArtifactProof,
} = GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_OBLIGATIONS;

const ALWAYS_OBLIGATIONS = Object.freeze([
  verifiedArtifactTransport,
  changedArtifactLoadIntoTargetProcess,
  epochPublication,
  loadedArtifactEpochBinding,
  postPublicationDispatch,
  dispatchEpochArtifactBinding,
  sameProcessHostIdentity,
  outputAfterDispatchOracleBinding,
  retirementSafety,
  abiCompatibility,
  cpuHmrFullRebuildRestartFirewall,
]);

const COMPUTE_OBLIGATIONS = Object.freeze([
  computeRawReadbackBytes,
  computeReadbackSchema,
  computeBeforeAfterChecksum,
  computeDeterministicSlice,
]);

const VISUAL_OBLIGATIONS = Object.freeze([
  visualVerifiedBeforeBytes,
  visualVerifiedAfterBytes,
  visualVerifiedDiffBytes,
  visualDeterministicControls,
  visualPostEpochFrameBoundary,
  visualBlankFrameRejection,
  visualStaleFrameRejection,
  visualJitterRejection,
  visualTemporalEffectRejection,
]);

const PIPELINE_OBJECT_OBLIGATIONS = Object.freeze([
  pipelineRecreation,
  pipelineIdentityEpochBinding,
]);

const RECORD_AFTER_PUBLICATION_OBLIGATIONS = Object.freeze([
  postPublicationCommandRecording,
  newRecordingChangedArtifactProof,
]);

const PRE_RECORDED_COMMAND_OBLIGATIONS = Object.freeze([
  oldCommandInvalidation,
  oldCommandRetirement,
  postPublicationCommandRecording,
  postPublicationCommandRerecord,
  newRecordingChangedArtifactProof,
]);

const COMMAND_RECORDING_OBLIGATION_ORDER = Object.freeze([
  oldCommandInvalidation,
  oldCommandRetirement,
  postPublicationCommandRecording,
  postPublicationCommandRerecord,
  newRecordingChangedArtifactProof,
]);

const BOUNDARY_OBLIGATIONS = Object.freeze([
  explicitAppHookContract,
  runtimeBoundaryEvidence,
]);

const OBLIGATION_ORDER = Object.freeze([
  ...ALWAYS_OBLIGATIONS,
  runtimeCompilerSourceToArtifactProof,
  ...BOUNDARY_OBLIGATIONS,
  ...COMPUTE_OBLIGATIONS,
  ...VISUAL_OBLIGATIONS,
  ...PIPELINE_OBJECT_OBLIGATIONS,
  ...COMMAND_RECORDING_OBLIGATION_ORDER,
  ...GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OWNERS.flatMap(
    (owner) => GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS[owner],
  ),
]);

const BOUNDARY_ARTIFACT_FORMATS = new Set(['engine_asset', 'opaque_payload']);
const BOUNDARY_PUBLICATION_MODELS = new Set([
  'engine_managed_epoch',
  'opaque_callback_epoch',
]);
const BOUNDARY_COMMAND_RECORDING_MODELS = new Set(['opaque_engine_managed']);
const BOUNDARY_PIPELINE_CACHE_OWNERS = new Set([
  'application',
  'engine',
  'opaque_external',
]);

function fail(code, detail = '') {
  const suffix = detail === '' ? '' : `:${String(detail)}`;
  throw new TypeError(`gpu_hmr_runtime_adapter_capabilities_${code}${suffix}`);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareStrings).map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function plainDataTreeFailure(value) {
  const pending = [{ value, leave: false }];
  const active = new Set();
  const complete = new Set();
  while (pending.length > 0) {
    const entry = pending.pop();
    const current = entry.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return 'nonfinite_number';
      if (Object.is(current, -0)) return 'negative_zero';
      continue;
    }
    if (typeof current === 'undefined') return 'undefined_value';
    if (typeof current === 'bigint') return 'bigint';
    if (typeof current === 'symbol') return 'symbol_value';
    if (typeof current === 'function') return 'function_value';
    if (typeof current !== 'object') return 'unsupported_value';
    try {
      if (utilTypes.isProxy(current)) return 'proxy';
    } catch {
      return 'introspection_failed';
    }
    if (entry.leave) {
      active.delete(current);
      complete.add(current);
      continue;
    }
    if (complete.has(current)) continue;
    if (active.has(current)) return 'cycle';
    active.add(current);
    pending.push({ value: current, leave: true });

    let descriptors;
    let keys;
    let prototype;
    let array;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current);
      keys = Reflect.ownKeys(descriptors);
      prototype = Object.getPrototypeOf(current);
      array = Array.isArray(current);
    } catch {
      return 'introspection_failed';
    }
    if (keys.some((key) => typeof key !== 'string')) return 'symbol_property';
    if (array) {
      if (prototype !== Array.prototype) return 'array_prototype';
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor?.value;
      if (
        !lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(length)
        || length < 0
        || keys.length !== length + 1
      ) return 'array_shape';
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return 'array_accessor';
        if (descriptor.enumerable !== true) return 'array_descriptor';
        pending.push({ value: descriptor.value, leave: false });
      }
      continue;
    }
    if (prototype !== Object.prototype) return 'object_prototype';
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value')) return 'accessor_property';
      if (descriptor.enumerable !== true) return 'object_property_descriptor';
      pending.push({ value: descriptor.value, leave: false });
    }
  }
  return null;
}

function capabilityFacetIntegrityResult(failures, recomputedFacet = null) {
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  const acceptedAsSupportEvidence = uniqueFailures.length === 0 && recomputedFacet !== null;
  return Object.freeze({
    schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_INTEGRITY_SCHEMA_VERSION,
    authority: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_INTEGRITY_AUTHORITY,
    valid: acceptedAsSupportEvidence,
    acceptedAsSupportEvidence,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    failures: uniqueFailures,
    recomputedFacet: acceptedAsSupportEvidence ? recomputedFacet : null,
  });
}

function descriptorIsAccessor(descriptor) {
  return Object.hasOwn(descriptor, 'get') || Object.hasOwn(descriptor, 'set');
}

function requireExactCapabilityFacts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('facts_must_be_plain_data_record');
  }
  if (utilTypes.isProxy(value)) fail('facts_proxy_forbidden');
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail('facts_must_be_plain_data_record');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  for (const key of ownKeys) {
    if (typeof key !== 'string') fail('facts_symbol_key_forbidden');
    const descriptor = descriptors[key];
    if (descriptorIsAccessor(descriptor)) fail('facts_accessor_forbidden', key);
    if (descriptor.enumerable !== true) fail('facts_non_enumerable_field', key);
    if (!CAPABILITY_FACT_FIELD_SET.has(key)) fail('facts_unknown_field', key);
  }
  for (const field of GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS) {
    if (!Object.hasOwn(descriptors, field)) fail('facts_missing_field', field);
  }
  if (ownKeys.length !== GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS.length) {
    fail('facts_shape_invalid');
  }
  return Object.fromEntries(
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS.map(
      (field) => [field, descriptors[field].value],
    ),
  );
}

function requireExactPlainInput(value) {
  if (value === null || typeof value !== 'object') {
    fail('input_must_be_plain_data_record');
  }
  if (utilTypes.isProxy(value)) fail('input_proxy_forbidden');
  if (Array.isArray(value)) fail('input_must_be_plain_data_record');
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail('input_must_be_plain_data_record');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  for (const key of ownKeys) {
    if (typeof key !== 'string') fail('input_symbol_key_forbidden');
    const descriptor = descriptors[key];
    if (descriptorIsAccessor(descriptor)) fail('input_accessor_forbidden', key);
    if (descriptor.enumerable !== true) fail('input_non_enumerable_field', key);
    if (!INPUT_FIELD_SET.has(key)) fail('input_unknown_field', key);
  }
  for (const field of GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS) {
    if (!Object.hasOwn(descriptors, field)) fail('input_missing_field', field);
  }
  if (ownKeys.length !== GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS.length) {
    fail('input_shape_invalid');
  }

  return Object.fromEntries(
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS.map(
      (field) => [field, descriptors[field].value],
    ),
  );
}

function requireEnum(value, accepted, label) {
  if (typeof value !== 'string' || !accepted.has(value)) fail(`${label}_invalid`);
  return value;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireEvidenceReference(value, index) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REF_BYTES
    || /[\p{Cc}\u2028\u2029]/u.test(value)
    || hasUnpairedSurrogate(value)
  ) {
    fail('evidence_ref_invalid', index);
  }
  return value;
}

function requireEvidenceRefs(value) {
  if (value === null || typeof value !== 'object') fail('evidence_refs_invalid');
  if (utilTypes.isProxy(value)) fail('evidence_refs_proxy_forbidden');
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('evidence_refs_must_be_plain_array');
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  for (const key of ownKeys) {
    if (typeof key !== 'string') fail('evidence_refs_symbol_key_forbidden');
    const descriptor = descriptors[key];
    if (descriptorIsAccessor(descriptor)) fail('evidence_refs_accessor_forbidden', key);
  }

  const lengthDescriptor = descriptors.length;
  const length = lengthDescriptor?.value;
  if (
    !Number.isInteger(length)
    || length < 1
    || length > GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REFS
  ) {
    fail('evidence_refs_length_invalid');
  }

  const references = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true) {
      fail('evidence_refs_sparse_or_non_enumerable', index);
    }
    references.push(requireEvidenceReference(descriptor.value, index));
  }

  const expectedKeys = new Set(['length', ...references.map((_, index) => String(index))]);
  if (ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key))) {
    fail('evidence_refs_extra_property_forbidden');
  }
  if (new Set(references).size !== references.length) {
    fail('evidence_refs_duplicate');
  }
  const totalBytes = references.reduce(
    (total, reference) => total + Buffer.byteLength(reference, 'utf8'),
    0,
  );
  if (totalBytes > GPU_HMR_RUNTIME_ADAPTER_MAX_EVIDENCE_REFS_BYTES) {
    fail('evidence_refs_total_bytes_exceeded');
  }
  return Object.freeze([...references].sort(compareStrings));
}

function requireOracleKind(value, outputModality) {
  if (typeof value !== 'string') fail('oracle_kind_invalid');
  const classification = classifyGpuHmrOutputOracleKind(value);
  if (!classification.accepted) fail('oracle_kind_invalid');
  if (classification.kind !== value) fail('oracle_kind_not_canonical');
  if (classification.modality !== outputModality) fail('oracle_kind_modality_mismatch');
  return classification.kind;
}

function requiresExplicitRuntimeBoundary(capabilities) {
  return BOUNDARY_ARTIFACT_FORMATS.has(capabilities.artifactFormat)
    || BOUNDARY_PUBLICATION_MODELS.has(capabilities.publicationModel)
    || BOUNDARY_COMMAND_RECORDING_MODELS.has(capabilities.commandRecordingModel)
    || BOUNDARY_PIPELINE_CACHE_OWNERS.has(capabilities.pipelineCacheOwner);
}

export function deriveGpuHmrRuntimeAdapterCapabilityObligations(input) {
  const source = requireExactCapabilityFacts(input);
  const outputModality = requireEnum(
    source.outputModality,
    OUTPUT_MODALITY_SET,
    'output_modality',
  );
  const capabilities = Object.freeze({
    artifactFormat: requireEnum(
      source.artifactFormat,
      ARTIFACT_FORMAT_SET,
      'artifact_format',
    ),
    outputModality,
    oracleKind: requireOracleKind(source.oracleKind, outputModality),
    publicationModel: requireEnum(
      source.publicationModel,
      PUBLICATION_MODEL_SET,
      'publication_model',
    ),
    commandRecordingModel: requireEnum(
      source.commandRecordingModel,
      COMMAND_RECORDING_MODEL_SET,
      'command_recording_model',
    ),
    pipelineCacheOwner: requireEnum(
      source.pipelineCacheOwner,
      PIPELINE_CACHE_OWNER_SET,
      'pipeline_cache_owner',
    ),
  });
  const selected = new Set(ALWAYS_OBLIGATIONS);

  if (capabilities.artifactFormat === 'runtime_source') {
    selected.add(runtimeCompilerSourceToArtifactProof);
  }
  if (requiresExplicitRuntimeBoundary(capabilities)) {
    BOUNDARY_OBLIGATIONS.forEach((obligation) => selected.add(obligation));
  }
  const modalityObligations = capabilities.outputModality === 'compute'
    ? COMPUTE_OBLIGATIONS
    : VISUAL_OBLIGATIONS;
  modalityObligations.forEach((obligation) => selected.add(obligation));

  if (capabilities.publicationModel === 'pipeline_object_epoch') {
    PIPELINE_OBJECT_OBLIGATIONS.forEach((obligation) => selected.add(obligation));
  }
  if (capabilities.commandRecordingModel === 'record_after_publication') {
    RECORD_AFTER_PUBLICATION_OBLIGATIONS.forEach((obligation) => selected.add(obligation));
  }
  if (capabilities.commandRecordingModel === 'pre_recorded_commands') {
    PRE_RECORDED_COMMAND_OBLIGATIONS.forEach((obligation) => selected.add(obligation));
  }
  GPU_HMR_RUNTIME_ADAPTER_PIPELINE_CACHE_OBLIGATIONS[
    capabilities.pipelineCacheOwner
  ].forEach((obligation) => selected.add(obligation));

  return Object.freeze(OBLIGATION_ORDER.filter((obligation) => selected.has(obligation)));
}

export function createGpuHmrRuntimeAdapterCapabilities(input) {
  const source = requireExactPlainInput(input);
  const artifactFormat = requireEnum(
    source.artifactFormat,
    ARTIFACT_FORMAT_SET,
    'artifact_format',
  );
  const outputModality = requireEnum(
    source.outputModality,
    OUTPUT_MODALITY_SET,
    'output_modality',
  );
  const oracleKind = requireOracleKind(source.oracleKind, outputModality);
  const publicationModel = requireEnum(
    source.publicationModel,
    PUBLICATION_MODEL_SET,
    'publication_model',
  );
  const commandRecordingModel = requireEnum(
    source.commandRecordingModel,
    COMMAND_RECORDING_MODEL_SET,
    'command_recording_model',
  );
  const pipelineCacheOwner = requireEnum(
    source.pipelineCacheOwner,
    PIPELINE_CACHE_OWNER_SET,
    'pipeline_cache_owner',
  );
  const evidenceRefs = requireEvidenceRefs(source.evidenceRefs);

  const capabilities = Object.freeze({
    artifactFormat,
    outputModality,
    oracleKind,
    publicationModel,
    commandRecordingModel,
    pipelineCacheOwner,
    evidenceRefs,
  });
  const obligations = deriveGpuHmrRuntimeAdapterCapabilityObligations(
    Object.fromEntries(
      GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS.map(
        (field) => [field, capabilities[field]],
      ),
    ),
  );
  const capabilitiesHash = canonicalSha256({
    domain: `${GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION}.capabilities`,
    capabilities,
  });
  const obligationsHash = canonicalSha256({
    domain: `${GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION}.obligations`,
    obligations,
  });
  const bindingHash = canonicalSha256({
    schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
    authority: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_AUTHORITY,
    capabilities,
    obligations,
    capabilitiesHash,
    obligationsHash,
  });

  return Object.freeze({
    schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
    authority: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_AUTHORITY,
    ...capabilities,
    obligations,
    capabilitiesHash,
    obligationsHash,
    bindingHash,
    proofId: `runtime-adapter-capabilities:${bindingHash}`,
    valid: true,
    acceptedAsSupportEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  });
}

export function evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity(facet) {
  const shapeFailure = plainDataTreeFailure(facet);
  if (shapeFailure) {
    return capabilityFacetIntegrityResult([
      `runtime_adapter_capabilities_facet_plain_data_${shapeFailure}`,
    ]);
  }
  if (facet === null || typeof facet !== 'object' || Array.isArray(facet)) {
    return capabilityFacetIntegrityResult(['runtime_adapter_capabilities_facet_not_object']);
  }

  const keys = Object.keys(facet);
  if (
    keys.length !== CAPABILITY_FACET_FIELDS.length
    || keys.some((key) => !CAPABILITY_FACET_FIELD_SET.has(key))
    || CAPABILITY_FACET_FIELDS.some((key) => !Object.hasOwn(facet, key))
  ) {
    return capabilityFacetIntegrityResult(['runtime_adapter_capabilities_facet_field_set_mismatch']);
  }

  let recomputedFacet;
  try {
    recomputedFacet = createGpuHmrRuntimeAdapterCapabilities(Object.fromEntries(
      GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS.map((field) => [field, facet[field]]),
    ));
  } catch {
    return capabilityFacetIntegrityResult(['runtime_adapter_capabilities_facet_input_invalid']);
  }

  const failures = [];
  if (facet.schemaVersion !== GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION) {
    failures.push('runtime_adapter_capabilities_facet_schema_mismatch');
  }
  if (facet.authority !== GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_AUTHORITY) {
    failures.push('runtime_adapter_capabilities_facet_authority_mismatch');
  }
  if (
    facet.acceptedForGpuHmr !== false
    || facet.gpuHmrSuccess !== false
    || facet.canSatisfyRuntimeProof !== false
    || facet.canSatisfyDispatchProof !== false
  ) {
    failures.push('runtime_adapter_capabilities_facet_success_authority_forbidden');
  }
  if (facet.valid !== true || facet.acceptedAsSupportEvidence !== true) {
    failures.push('runtime_adapter_capabilities_facet_support_state_invalid');
  }
  for (const field of CAPABILITY_FACET_FIELDS) {
    if (stableJson(facet[field]) !== stableJson(recomputedFacet[field])) {
      failures.push(`runtime_adapter_capabilities_facet_${field}_mismatch`);
    }
  }
  return capabilityFacetIntegrityResult(failures, failures.length === 0 ? recomputedFacet : null);
}
