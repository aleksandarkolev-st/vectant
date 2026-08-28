import { types as utilTypes } from 'node:util';

import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_AUTHORITY,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS,
  createGpuHmrRuntimeAdapterCapabilities,
  evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity,
} from './gpu-hmr-runtime-adapter-capabilities.mjs';
import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_AUTHORITY,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2,
  createGpuHmrRuntimeAdapterCapabilitiesV2,
  evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity,
} from './gpu-hmr-runtime-adapter-capabilities-v2.mjs';

export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_ENVELOPE_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_adapter_capabilities.support_envelope.v1';
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_AUTHORITY =
  'versioned_capability_support_only_not_evidence_or_gpu_hmr_success';
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_INTEGRITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_adapter_capabilities.support_envelope_integrity.v1';
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_INTEGRITY_AUTHORITY =
  'versioned_capability_support_envelope_integrity_only_not_evidence_or_gpu_hmr_success';

export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
]);

const MAX_PLAIN_DATA_DEPTH = 16;
const MAX_PLAIN_DATA_NODES = 512;
const MAX_PLAIN_DATA_ARRAY_LENGTH = 128;
const MAX_PLAIN_DATA_OBJECT_FIELDS = 64;
const MAX_PLAIN_DATA_STRING_BYTES = 4096;
const MAX_PLAIN_DATA_TOTAL_STRING_BYTES = 64 * 1024;

const SUPPORT_AUTHORITY_FIELDS = Object.freeze([
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]);
const FACET_TRAILER_FIELDS = Object.freeze([
  'obligations',
  'capabilitiesHash',
  'obligationsHash',
  'bindingHash',
  'proofId',
  'valid',
  ...SUPPORT_AUTHORITY_FIELDS,
]);
const V1_FACET_FIELDS = Object.freeze([
  'schemaVersion',
  'authority',
  ...GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS,
  ...FACET_TRAILER_FIELDS,
]);
const V2_FACET_FIELDS = Object.freeze([
  'schemaVersion',
  'authority',
  ...GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2,
  ...FACET_TRAILER_FIELDS,
]);
const V1_CREATE_FIELDS = Object.freeze([
  'schemaVersion',
  ...GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS,
]);
const V2_CREATE_FIELDS = Object.freeze([
  'schemaVersion',
  ...GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2,
]);
const V1_FACET_FIELD_SET = new Set(V1_FACET_FIELDS);
const V2_FACET_FIELD_SET = new Set(V2_FACET_FIELDS);
const V1_CREATE_FIELD_SET = new Set(V1_CREATE_FIELDS);
const V2_CREATE_FIELD_SET = new Set(V2_CREATE_FIELDS);
const V2_ONLY_FIELDS = new Set(
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2.filter(
    (field) => !GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS.includes(field),
  ),
);

function fail(code, detail = '') {
  const suffix = detail === '' ? '' : `:${String(detail)}`;
  throw new TypeError(`gpu_hmr_runtime_adapter_capabilities_versioned_${code}${suffix}`);
}

function plainDataFailure(value) {
  const pending = [{ value, leave: false, depth: 0 }];
  const active = new Set();
  const complete = new Set();
  let nodes = 0;
  let totalStringBytes = 0;
  const accountString = (candidate) => {
    const bytes = Buffer.byteLength(candidate, 'utf8');
    if (bytes > MAX_PLAIN_DATA_STRING_BYTES) return 'string_bytes';
    totalStringBytes += bytes;
    return totalStringBytes > MAX_PLAIN_DATA_TOTAL_STRING_BYTES
      ? 'total_string_bytes'
      : null;
  };

  while (pending.length > 0) {
    const entry = pending.pop();
    const current = entry.value;
    if (current === null || typeof current === 'boolean') continue;
    if (typeof current === 'string') {
      const failure = accountString(current);
      if (failure) return failure;
      continue;
    }
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
    if (entry.depth > MAX_PLAIN_DATA_DEPTH) return 'depth';
    if (complete.has(current)) continue;
    if (active.has(current)) return 'cycle';
    nodes += 1;
    if (nodes > MAX_PLAIN_DATA_NODES) return 'nodes';
    active.add(current);
    pending.push({ value: current, leave: true, depth: entry.depth });

    let descriptors;
    let keys;
    let prototype;
    let array;
    try {
      prototype = Object.getPrototypeOf(current);
      array = Array.isArray(current);
      descriptors = Object.getOwnPropertyDescriptors(current);
      keys = Reflect.ownKeys(descriptors);
    } catch {
      return 'introspection_failed';
    }
    if (keys.some((key) => typeof key !== 'string')) return 'symbol_property';
    if (array) {
      if (prototype !== Array.prototype) return 'array_prototype';
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor?.value;
      if (!lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(length)
        || length < 0
        || length > MAX_PLAIN_DATA_ARRAY_LENGTH
        || keys.length !== length + 1) return 'array_shape';
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return 'array_accessor';
        if (descriptor.enumerable !== true) return 'array_descriptor';
        pending.push({ value: descriptor.value, leave: false, depth: entry.depth + 1 });
      }
      continue;
    }
    if (prototype !== Object.prototype) return 'object_prototype';
    if (keys.length > MAX_PLAIN_DATA_OBJECT_FIELDS) return 'object_fields';
    for (const key of keys) {
      const stringFailure = accountString(key);
      if (stringFailure) return stringFailure;
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value')) return 'accessor_property';
      if (descriptor.enumerable !== true) return 'object_property_descriptor';
      pending.push({ value: descriptor.value, leave: false, depth: entry.depth + 1 });
    }
  }
  return null;
}

function rootRecord(value, label) {
  const plainFailure = plainDataFailure(value);
  if (plainFailure) fail(`${label}_plain_data_${plainFailure}`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}_not_record`);
  }
  return Object.getOwnPropertyDescriptors(value);
}

function versionFromDescriptors(descriptors, label) {
  const hasCamel = Object.hasOwn(descriptors, 'schemaVersion');
  const hasSnake = Object.hasOwn(descriptors, 'schema_version');
  if (hasCamel && hasSnake) {
    const code = descriptors.schemaVersion.value === descriptors.schema_version.value
      ? 'version_alias_duplicate'
      : 'version_alias_conflict';
    fail(`${label}_${code}`);
  }
  if (hasSnake) fail(`${label}_version_alias_forbidden`);
  if (!hasCamel || typeof descriptors.schemaVersion.value !== 'string') {
    fail(`${label}_schema_version_missing`);
  }
  return descriptors.schemaVersion.value;
}

function requireExactFieldSet(descriptors, fields, fieldSet, label, version) {
  const keys = Object.keys(descriptors);
  const extra = keys.filter((key) => !fieldSet.has(key));
  if (extra.length > 0) {
    if (version === GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION
      && extra.some((key) => V2_ONLY_FIELDS.has(key))) {
      fail(`${label}_mixed_version_fields`);
    }
    fail(`${label}_unknown_field`, extra.sort()[0]);
  }
  const missing = fields.filter((field) => !Object.hasOwn(descriptors, field));
  if (missing.length > 0 || keys.length !== fields.length) {
    fail(`${label}_field_set_mismatch`, missing[0] ?? 'count');
  }
}

function selectVersion(descriptors, label, fieldKind) {
  const version = versionFromDescriptors(descriptors, label);
  const isV1 = version === GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION;
  const isV2 = version === GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION;
  if (!isV1 && !isV2) fail(`${label}_schema_version_unknown`);
  const fields = fieldKind === 'facet'
    ? (isV1 ? V1_FACET_FIELDS : V2_FACET_FIELDS)
    : (isV1 ? V1_CREATE_FIELDS : V2_CREATE_FIELDS);
  const fieldSet = fieldKind === 'facet'
    ? (isV1 ? V1_FACET_FIELD_SET : V2_FACET_FIELD_SET)
    : (isV1 ? V1_CREATE_FIELD_SET : V2_CREATE_FIELD_SET);
  requireExactFieldSet(descriptors, fields, fieldSet, label, version);
  return Object.freeze({ version, isV1, fields });
}

function supportEnvelope(version, recomputedFacet) {
  return Object.freeze({
    envelopeSchemaVersion:
      GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_ENVELOPE_SCHEMA_VERSION,
    schemaVersion: version,
    authority: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_AUTHORITY,
    historical: version === GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
    valid: true,
    facet: recomputedFacet,
    obligations: recomputedFacet.obligations,
    capabilitiesHash: recomputedFacet.capabilitiesHash,
    obligationsHash: recomputedFacet.obligationsHash,
    bindingHash: recomputedFacet.bindingHash,
    proofId: recomputedFacet.proofId,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  });
}

function integrityResult(failures, envelope = null) {
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  return Object.freeze({
    schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_INTEGRITY_SCHEMA_VERSION,
    authority: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_INTEGRITY_AUTHORITY,
    valid: uniqueFailures.length === 0 && envelope !== null,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    failures: uniqueFailures,
    recomputedEnvelope: uniqueFailures.length === 0 ? envelope : null,
  });
}

export function evaluateGpuHmrRuntimeAdapterCapabilitiesVersionedIntegrity(facet) {
  let selection;
  try {
    selection = selectVersion(rootRecord(facet, 'facet'), 'facet', 'facet');
  } catch (error) {
    return integrityResult([error instanceof Error ? error.message : 'facet_invalid']);
  }

  const result = selection.isV1
    ? evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity(facet)
    : evaluateGpuHmrRuntimeAdapterCapabilitiesV2Integrity(facet);
  if (!result.valid || result.recomputedFacet === null) {
    return integrityResult(result.failures.map((failure) => `matching_evaluator:${failure}`));
  }
  return integrityResult([], supportEnvelope(selection.version, result.recomputedFacet));
}

export function dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned(facet) {
  const result = evaluateGpuHmrRuntimeAdapterCapabilitiesVersionedIntegrity(facet);
  if (!result.valid || result.recomputedEnvelope === null) {
    fail('facet_rejected', result.failures[0] ?? 'unknown');
  }
  return result.recomputedEnvelope;
}

export function createGpuHmrRuntimeAdapterCapabilitiesVersioned(input) {
  const selection = selectVersion(rootRecord(input, 'create'), 'create', 'create');
  if (selection.isV1) fail('create_downgrade_forbidden');
  const facts = Object.fromEntries(
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_INPUT_FIELDS_V2.map(
      (field) => [field, input[field]],
    ),
  );
  const facet = createGpuHmrRuntimeAdapterCapabilitiesV2(facts);
  return dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned(facet);
}

export const readGpuHmrRuntimeAdapterCapabilitiesVersioned =
  dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned;

export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_LEGACY_AUTHORITY =
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_AUTHORITY;
export const GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_CURRENT_AUTHORITY =
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_AUTHORITY;
