import { types as nodeTypes } from 'node:util';
import {
  GPU_HMR_TEST_TIMING_V3_CLOCK,
  GPU_HMR_TEST_TIMING_V3_MAX_NS_DIGITS,
  getGpuHmrTestTimingV3ClockSourceManifest,
  validateGpuHmrTestTimingV3,
  validateGpuHmrTestTimingV3PersistenceReceipt,
} from './gpu-hmr-test-timing-v3.mjs';

export const GPU_HMR_TIMING_METRICS_SCHEMA_VERSION = 'synthi.gpu.hmr.timing_metrics.v1';
export const GPU_HMR_TIMING_TELEMETRY_AUTHORITY = 'timing_telemetry_only';

const CANONICAL_NS = /^(0|[1-9][0-9]*)$/;
const MISSING = Symbol('missing');
const REJECTED = Symbol('rejected');
const EMPTY_DATA_OBJECT = Object.freeze(Object.create(null));

const TRUST_GRAPH_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 250_000,
  maxTotalKeys: 500_000,
  maxArrayLength: 100_000,
  maxStringBytes: 32 * 1024 * 1024,
});
const REPORT_GRAPH_LIMITS = Object.freeze({
  maxDepth: 128,
  maxNodes: 1_000_000,
  maxTotalKeys: 2_000_000,
  maxArrayLength: 1_000_000,
  maxStringBytes: 256 * 1024 * 1024,
});
const OPTIONS_GRAPH_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 1_024,
  maxTotalKeys: 4_096,
  maxArrayLength: 256,
  maxStringBytes: 1024 * 1024,
});

function invalidMaterial(label, reason, path) {
  return {
    valid: false,
    reason: `${label}_${reason}`,
    gaps: [`${label}_${reason}:${path}`],
  };
}

function inspectBoundedDataGraph(root, label, limits) {
  const states = new WeakMap();
  const stack = [{ value: root, depth: 0, path: '$', exit: false }];
  let nodes = 0;
  let totalKeys = 0;
  let stringBytes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    const { value, depth, path, exit } = frame;
    if (value === null) continue;
    const valueType = typeof value;
    if (valueType !== 'object') {
      if (valueType === 'string') {
        stringBytes += Buffer.byteLength(value, 'utf8');
        if (stringBytes > limits.maxStringBytes) {
          return invalidMaterial(label, 'string_bytes_limit_exceeded', path);
        }
        continue;
      }
      if (valueType === 'boolean' || (valueType === 'number' && Number.isFinite(value))) {
        continue;
      }
      return invalidMaterial(label, 'non_data_primitive_rejected', path);
    }

    if (nodeTypes.isProxy(value)) {
      return invalidMaterial(label, 'proxy_rejected', path);
    }
    if (exit) {
      states.set(value, 'done');
      continue;
    }
    const state = states.get(value);
    if (state === 'visiting') return invalidMaterial(label, 'cycle_rejected', path);
    if (state === 'done') continue;
    if (depth > limits.maxDepth) {
      return invalidMaterial(label, 'depth_limit_exceeded', path);
    }
    nodes += 1;
    if (nodes > limits.maxNodes) return invalidMaterial(label, 'node_limit_exceeded', path);

    let prototype;
    let keys;
    try {
      prototype = Object.getPrototypeOf(value);
      keys = Reflect.ownKeys(value);
    } catch {
      return invalidMaterial(label, 'descriptor_introspection_failed', path);
    }
    const isArray = Array.isArray(value);
    if (
      (isArray && prototype !== Array.prototype)
      || (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      return invalidMaterial(label, 'prototype_rejected', path);
    }
    if (keys.some((key) => typeof key !== 'string')) {
      return invalidMaterial(label, 'symbol_key_rejected', path);
    }
    totalKeys += keys.length;
    if (totalKeys > limits.maxTotalKeys) {
      return invalidMaterial(label, 'key_limit_exceeded', path);
    }

    let arrayLength = null;
    if (isArray) {
      let lengthDescriptor;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      } catch {
        return invalidMaterial(label, 'descriptor_introspection_failed', `${path}.length`);
      }
      if (
        !lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > limits.maxArrayLength
      ) {
        return invalidMaterial(label, 'array_length_invalid', path);
      }
      arrayLength = lengthDescriptor.value;
      if (keys.length !== arrayLength + 1) {
        return invalidMaterial(label, 'sparse_or_extended_array_rejected', path);
      }
    }

    const children = [];
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      if (isArray && (!CANONICAL_NS.test(key) || BigInt(key) >= BigInt(arrayLength))) {
        return invalidMaterial(label, 'sparse_or_extended_array_rejected', `${path}.${key}`);
      }
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        return invalidMaterial(label, 'descriptor_introspection_failed', `${path}.${key}`);
      }
      if (
        !descriptor
        || !Object.hasOwn(descriptor, 'value')
        || !descriptor.enumerable
      ) {
        return invalidMaterial(label, 'accessor_or_hidden_property_rejected', `${path}.${key}`);
      }
      stringBytes += Buffer.byteLength(key, 'utf8');
      if (stringBytes > limits.maxStringBytes) {
        return invalidMaterial(label, 'string_bytes_limit_exceeded', `${path}.${key}`);
      }
      children.push({
        value: descriptor.value,
        depth: depth + 1,
        path: isArray ? `${path}[${key}]` : `${path}.${key}`,
        exit: false,
      });
    }

    states.set(value, 'visiting');
    stack.push({ value, depth, path, exit: true });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  return { valid: true, reason: null, gaps: [] };
}

function ownDataValue(object, key) {
  if (object === null || (typeof object !== 'object' && typeof object !== 'function')) {
    return MISSING;
  }
  if (nodeTypes.isProxy(object)) return REJECTED;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    return REJECTED;
  }
  if (!descriptor) return MISSING;
  if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return REJECTED;
  return descriptor.value;
}

function dataPath(root, path) {
  let current = root;
  for (const key of path) {
    current = ownDataValue(current, key);
    if (current === MISSING || current === REJECTED) return null;
  }
  return current;
}

function dataObject(root, path) {
  const value = dataPath(root, path);
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && !nodeTypes.isProxy(value)
    ? value
    : null;
}

function dataObjectAlias(object, aliases) {
  let selected = MISSING;
  for (const alias of aliases) {
    const value = ownDataValue(object, alias);
    if (value === MISSING) continue;
    if (
      value === REJECTED
      || value === null
      || typeof value !== 'object'
      || Array.isArray(value)
      || nodeTypes.isProxy(value)
      || (selected !== MISSING && selected !== value)
    ) {
      return null;
    }
    selected = value;
  }
  return selected === MISSING ? null : selected;
}

function consistentDataObjectCandidates(...values) {
  const candidates = values.filter((value) => (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && !nodeTypes.isProxy(value)
  ));
  if (candidates.length === 0) return null;
  return candidates.every((value) => value === candidates[0]) ? candidates[0] : null;
}

function plainDataArray(value, limit = 2_048) {
  if (nodeTypes.isProxy(value) || !Array.isArray(value)) return null;
  let prototype;
  let lengthDescriptor;
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    return null;
  }
  if (
    prototype !== Array.prototype
    || !lengthDescriptor
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > limit
  ) {
    return null;
  }
  const entries = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const entry = ownDataValue(value, String(index));
    if (entry === MISSING || entry === REJECTED) return null;
    entries.push(entry);
  }
  return entries;
}

function finiteNumber(value) {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && !Object.is(value, -0)
    ? value
    : null;
}

function canonicalNs(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > GPU_HMR_TEST_TIMING_V3_MAX_NS_DIGITS
    || !CANONICAL_NS.test(value)
  ) {
    return null;
  }
  return value;
}

function nsToFiniteMs(value) {
  const ns = canonicalNs(value);
  if (ns === null) return null;
  const milliseconds = Number(BigInt(ns)) / 1_000_000;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function legacyNsToMs(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) return null;
    value = String(value);
  }
  return nsToFiniteMs(value);
}

function resolvePrimitiveAliases(objects, aliases, parse) {
  const parsed = [];
  let present = false;
  for (const object of objects) {
    for (const alias of aliases) {
      const value = ownDataValue(object, alias);
      if (value === MISSING) continue;
      present = true;
      if (value === REJECTED) return { present, valid: false, value: null };
      const normalized = parse(value);
      if (normalized === null) return { present, valid: false, value: null };
      parsed.push(normalized);
    }
  }
  if (!present) return { present: false, valid: false, value: null };
  if (parsed.some((value) => !Object.is(value, parsed[0]))) {
    return { present: true, valid: false, value: null };
  }
  return { present: true, valid: true, value: parsed[0] };
}

function legacyNsAlias(object, aliases) {
  const resolved = resolvePrimitiveAliases([object], aliases, legacyNsToMs);
  return resolved.valid ? resolved.value : null;
}

function legacyMsAlias(object, aliases) {
  const resolved = resolvePrimitiveAliases([object], aliases, finiteNumber);
  return resolved.valid ? resolved.value : null;
}

function legacyValues(...values) {
  return values.flat().filter((value) => finiteNumber(value) !== null);
}

function dataPathValue(root, path) {
  let current = root;
  for (const key of path) {
    current = ownDataValue(current, key);
    if (current === MISSING || current === REJECTED) return current;
  }
  return current;
}

function resolveDataPathCandidates(root, paths, parse) {
  let present = false;
  let selected = MISSING;
  for (const path of paths) {
    const candidate = dataPathValue(root, path);
    if (candidate === MISSING) continue;
    present = true;
    if (candidate === REJECTED) return { present, valid: false, value: null };
    const parsed = parse(candidate);
    if (parsed === REJECTED || (selected !== MISSING && !Object.is(selected, parsed))) {
      return { present, valid: false, value: null };
    }
    selected = parsed;
  }
  return selected === MISSING
    ? { present: false, valid: false, value: null }
    : { present, valid: true, value: selected };
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : REJECTED;
}

function nullableString(value) {
  return value === null ? null : nonemptyString(value);
}

function artifactBindingValue(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return REJECTED;
  const kind = ownDataValue(value, 'kind');
  const reasonCode = ownDataValue(value, 'reasonCode');
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return REJECTED;
  }
  return keys.length === 2
    && keys.includes('kind')
    && keys.includes('reasonCode')
    && typeof kind === 'string'
    && typeof reasonCode === 'string'
    ? value
    : REJECTED;
}

const REPORT_BINDING_PATHS = Object.freeze({
  runMode: [['runMode'], ['run_mode']],
  splitMode: [['splitMode'], ['split_mode']],
  sourceManifestHash: [
    ['sourceManifestHash'],
    ['source_manifest_hash'],
    ['sourceManifest', 'hash'],
    ['source_manifest', 'hash'],
    ['project', 'sourceManifestHash'],
    ['project', 'source_manifest_hash'],
  ],
  editId: [['editId'], ['edit_id'], ['edit', 'id']],
  editHash: [['editHash'], ['edit_hash'], ['edit', 'hash']],
  artifactHash: [['artifactHash'], ['artifact_hash'], ['artifact', 'hash']],
  proofLedgerId: [
    ['proofLedgerId'],
    ['proof_ledger_id'],
    ['proofLedger', 'id'],
    ['proof_ledger', 'id'],
  ],
  runtimeProofId: [
    ['runtimeProofId'],
    ['runtime_proof_id'],
    ['runtimeProof', 'id'],
    ['runtime_proof', 'id'],
  ],
  runtimeSessionId: [
    ['runtimeSessionId'],
    ['runtime_session_id'],
    ['runtimeSession', 'id'],
    ['runtime_session', 'id'],
  ],
  processIdentity: [
    ['processIdentity'],
    ['process_identity'],
    ['runtimeProcess', 'identity'],
    ['runtime_process', 'identity'],
  ],
  clockSourceManifestId: [
    ['clockSourceManifestId'],
    ['clock_source_manifest_id'],
    ['timingClock', 'sourceManifestId'],
    ['timing_clock', 'source_manifest_id'],
  ],
  clockSourceIdentityHash: [
    ['clockSourceIdentityHash'],
    ['clock_source_identity_hash'],
    ['timingClock', 'sourceIdentityHash'],
    ['timing_clock', 'source_identity_hash'],
  ],
  clockDomainId: [
    ['clockDomainId'],
    ['clock_domain_id'],
    ['timingClock', 'domainId'],
    ['timing_clock', 'domain_id'],
  ],
  modality: [['outputModality'], ['output_modality'], ['modality']],
});

function reportBindingFromContext(report, outcome, manifest) {
  const gaps = [];
  const safeManifest = manifest !== null
    && typeof manifest === 'object'
    && !Array.isArray(manifest)
    && !nodeTypes.isProxy(manifest)
    ? manifest
    : EMPTY_DATA_OBJECT;
  if (safeManifest === EMPTY_DATA_OBJECT) gaps.push('trusted_clock_manifest_invalid');
  const reportModality = resolveDataPathCandidates(
    report,
    REPORT_BINDING_PATHS.modality,
    nonemptyString,
  );
  if (!reportModality.present) gaps.push('report_context_missing:modality');
  else if (!reportModality.valid || !['visual', 'compute'].includes(reportModality.value)) {
    gaps.push('report_context_conflict_or_invalid:modality');
  }
  if (outcome.conflict || outcome.status === null) {
    gaps.push('report_outcome_missing_or_conflicting');
  }

  const binding = {
    runMode: null,
    splitMode: null,
    modality: reportModality.valid ? reportModality.value : null,
    outcome: outcome.status === 'pass'
      ? 'completed'
      : outcome.status === 'fail'
        ? 'failed'
        : outcome.status === 'refused'
          ? 'refused'
          : null,
    sourceManifestHash: null,
    editId: null,
    editHash: null,
    artifactHash: null,
    proofLedgerId: null,
    runtimeProofId: null,
    runtimeSessionId: null,
    processIdentity: null,
    clockSourceManifestId: null,
    clockSourceIdentityHash: null,
    clockDomainId: null,
  };
  for (const field of [
    'runMode',
    'splitMode',
    'sourceManifestHash',
    'editId',
    'editHash',
    'runtimeSessionId',
    'processIdentity',
    'clockSourceManifestId',
    'clockSourceIdentityHash',
    'clockDomainId',
  ]) {
    const resolved = resolveDataPathCandidates(report, REPORT_BINDING_PATHS[field], nonemptyString);
    if (!resolved.present) gaps.push(`report_binding_missing:${field}`);
    else if (!resolved.valid) gaps.push(`report_binding_conflict_or_invalid:${field}`);
    else binding[field] = resolved.value;
  }
  for (const field of ['proofLedgerId', 'runtimeProofId']) {
    const resolved = resolveDataPathCandidates(report, REPORT_BINDING_PATHS[field], nullableString);
    if (!resolved.present) gaps.push(`report_binding_missing:${field}`);
    else if (!resolved.valid) gaps.push(`report_binding_conflict_or_invalid:${field}`);
    else binding[field] = resolved.value;
  }
  const artifactHash = resolveDataPathCandidates(
    report,
    REPORT_BINDING_PATHS.artifactHash,
    artifactBindingValue,
  );
  if (!artifactHash.present) gaps.push('report_binding_missing:artifactHash');
  else if (!artifactHash.valid) gaps.push('report_binding_conflict_or_invalid:artifactHash');
  else binding.artifactHash = artifactHash.value;

  const manifestComparisons = [
    ['runtimeSessionId', 'runtimeSessionId'],
    ['processIdentity', 'processIdentity'],
    ['clockSourceManifestId', 'manifestId'],
    ['clockSourceIdentityHash', 'clockSourceIdentityHash'],
    ['clockDomainId', 'clockDomainId'],
  ];
  for (const [bindingField, manifestField] of manifestComparisons) {
    if (
      binding[bindingField] !== null
      && binding[bindingField] !== ownDataValue(safeManifest, manifestField)
    ) {
      gaps.push(`report_clock_context_mismatch:${bindingField}`);
    }
  }

  return gaps.length === 0
    ? { valid: true, binding, gaps: [] }
    : { valid: false, binding: null, gaps };
}

function inspectTrustObject(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    return null;
  }
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return null;
  }
  if (
    (prototype !== Object.prototype && prototype !== null)
    || keys.length > 3
    || keys.some((key) => typeof key !== 'string')
  ) {
    return null;
  }
  const fields = Object.create(null);
  for (const key of keys) {
    const field = ownDataValue(value, key);
    if (field === MISSING || field === REJECTED) return null;
    fields[key] = field;
  }
  return { keys, fields };
}

function invalidTrust(reason, gaps = []) {
  return {
    valid: false,
    reason,
    gaps: [...gaps],
    record: null,
    validation: null,
    trustPath: null,
  };
}

function directTrustValidation(fields, keys, report, outcome) {
  if (
    keys.length !== 2
    || !keys.includes('record')
    || !keys.includes('trustedClockCapability')
  ) {
    return null;
  }
  let validation;
  try {
    const trustedClockSourceManifest = getGpuHmrTestTimingV3ClockSourceManifest(
      fields.trustedClockCapability,
    );
    const manifestInspection = inspectBoundedDataGraph(
      trustedClockSourceManifest,
      'trusted_clock_manifest',
      TRUST_GRAPH_LIMITS,
    );
    if (!manifestInspection.valid) {
      return invalidTrust(manifestInspection.reason, manifestInspection.gaps);
    }
    const reportBinding = reportBindingFromContext(
      report,
      outcome,
      trustedClockSourceManifest,
    );
    if (!reportBinding.valid) {
      return invalidTrust('trusted_v3_report_binding_unavailable', reportBinding.gaps);
    }
    validation = validateGpuHmrTestTimingV3(fields.record, {
      expectedBinding: reportBinding.binding,
      trustedClockSourceManifest,
    });
  } catch {
    return invalidTrust('trusted_v3_validation_threw');
  }
  return validation.valid
    ? {
        valid: true,
        reason: null,
        gaps: [],
        record: fields.record,
        validation,
        trustPath: 'trusted_v3_clock_capability_and_report_binding',
      }
    : {
        valid: false,
        reason: 'trusted_v3_validation_failed',
        gaps: [...validation.gaps],
        record: null,
        validation,
        trustPath: null,
      };
}

function exactOwnKeys(value, expectedKeys) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  return keys.length === expectedKeys.length
    && keys.every((key) => typeof key === 'string' && expectedKeys.includes(key));
}

function receiptTrustValidation(fields, keys, report, outcome) {
  if (
    keys.length !== 3
    || !keys.includes('record')
    || !keys.includes('persistenceReceipt')
    || !keys.includes('persistenceReceiptValidationOptions')
  ) {
    return null;
  }
  const suppliedReceiptOptions = fields.persistenceReceiptValidationOptions;
  if (!exactOwnKeys(suppliedReceiptOptions, [
    'expectedPersistencePlan',
    'timingRecordValidationOptions',
    'trustedWriterClockCapability',
    'expectedWriterIdentity',
    'expectedDestinationIdentity',
  ])) return invalidTrust('trusted_v3_persistence_validation_options_shape_invalid');
  const suppliedRecordOptions = ownDataValue(
    suppliedReceiptOptions,
    'timingRecordValidationOptions',
  );
  if (
    suppliedRecordOptions === MISSING
    || suppliedRecordOptions === REJECTED
    || !exactOwnKeys(suppliedRecordOptions, [
      'expectedBinding',
      'trustedClockSourceManifest',
    ])
  ) {
    return invalidTrust('trusted_v3_persistence_record_validation_options_invalid');
  }
  const trustedClockSourceManifest = ownDataValue(
    suppliedRecordOptions,
    'trustedClockSourceManifest',
  );
  const reportBinding = reportBindingFromContext(
    report,
    outcome,
    trustedClockSourceManifest,
  );
  if (!reportBinding.valid) {
    return invalidTrust('trusted_v3_report_binding_unavailable', reportBinding.gaps);
  }
  const recordValidationOptions = {
    expectedBinding: reportBinding.binding,
    trustedClockSourceManifest,
  };
  const receiptValidationOptions = {
    expectedPersistencePlan: ownDataValue(suppliedReceiptOptions, 'expectedPersistencePlan'),
    timingRecordValidationOptions: recordValidationOptions,
    trustedWriterClockCapability: ownDataValue(
      suppliedReceiptOptions,
      'trustedWriterClockCapability',
    ),
    expectedWriterIdentity: ownDataValue(suppliedReceiptOptions, 'expectedWriterIdentity'),
    expectedDestinationIdentity: ownDataValue(
      suppliedReceiptOptions,
      'expectedDestinationIdentity',
    ),
  };
  let receiptValidation;
  try {
    receiptValidation = validateGpuHmrTestTimingV3PersistenceReceipt(
      fields.persistenceReceipt,
      receiptValidationOptions,
    );
  } catch {
    return invalidTrust('trusted_v3_persistence_receipt_validation_threw');
  }
  if (!receiptValidation.valid) {
    return {
      valid: false,
      reason: 'trusted_v3_persistence_receipt_invalid',
      gaps: [...receiptValidation.gaps],
      record: null,
      validation: null,
      trustPath: null,
    };
  }
  let validation;
  try {
    validation = validateGpuHmrTestTimingV3(fields.record, recordValidationOptions);
  } catch {
    return {
      valid: false,
      reason: 'trusted_v3_persistence_record_validation_threw',
      gaps: [],
      record: null,
      validation: null,
      trustPath: null,
    };
  }
  const receiptRecordId = ownDataValue(fields.persistenceReceipt, 'timingRecordId');
  if (
    !validation.valid
    || receiptRecordId === MISSING
    || receiptRecordId === REJECTED
    || receiptRecordId !== validation.recomputedRecordId
  ) {
    return {
      valid: false,
      reason: 'trusted_v3_persistence_record_mismatch',
      gaps: validation.valid ? [] : [...validation.gaps],
      record: null,
      validation,
      trustPath: null,
    };
  }
  return {
    valid: true,
    reason: null,
    gaps: [],
    record: fields.record,
    validation,
    trustPath: 'verified_persistence_receipt',
  };
}

function validateTrustedV3(timingTrust, report, outcome, reportInspection) {
  if (!reportInspection.valid) {
    return invalidTrust('trusted_v3_report_material_invalid', reportInspection.gaps);
  }
  if (timingTrust === undefined || timingTrust === null) {
    return {
      valid: false,
      reason: 'trusted_v3_input_missing',
      gaps: [],
      record: null,
      validation: null,
      trustPath: null,
    };
  }
  const materialInspection = inspectBoundedDataGraph(
    timingTrust,
    'trusted_v3_input',
    TRUST_GRAPH_LIMITS,
  );
  if (!materialInspection.valid) {
    return invalidTrust(materialInspection.reason, materialInspection.gaps);
  }
  const inspected = inspectTrustObject(timingTrust);
  if (!inspected) {
    return {
      valid: false,
      reason: 'trusted_v3_input_invalid',
      gaps: [],
      record: null,
      validation: null,
      trustPath: null,
    };
  }
  return directTrustValidation(
    inspected.fields,
    inspected.keys,
    report,
    outcome,
  )
    ?? receiptTrustValidation(
      inspected.fields,
      inspected.keys,
      report,
      outcome,
    )
    ?? {
      valid: false,
      reason: 'trusted_v3_input_shape_invalid',
      gaps: [],
      record: null,
      validation: null,
      trustPath: null,
    };
}

function phaseByName(record, phaseName) {
  const phases = plainDataArray(ownDataValue(record, 'phases'), 64);
  if (!phases) return null;
  for (const phase of phases) {
    if (ownDataValue(phase, 'phase') === phaseName) return phase;
  }
  return null;
}

function phaseEndpointPairs(record, phaseName) {
  const phase = phaseByName(record, phaseName);
  const attempts = plainDataArray(ownDataValue(phase, 'attempts'), 64);
  const clock = ownDataValue(record, 'clock');
  const recordClockDomain = ownDataValue(clock, 'domainId');
  if (!attempts || attempts.length === 0 || typeof recordClockDomain !== 'string') return null;
  const pairs = [];
  for (const attempt of attempts) {
    const startNs = canonicalNs(ownDataValue(attempt, 'startNs'));
    const endNs = canonicalNs(ownDataValue(attempt, 'endNs'));
    const clockDomain = ownDataValue(attempt, 'clockDomainId');
    if (
      startNs === null
      || endNs === null
      || clockDomain !== recordClockDomain
      || BigInt(endNs) < BigInt(startNs)
    ) {
      return null;
    }
    pairs.push({ startNs, endNs, clockDomain });
  }
  return pairs;
}

function trustedClockMetadata(context) {
  if (!context.valid) {
    return {
      clockSource: null,
      clockUnit: null,
      clockDomain: null,
      clockSourceManifestId: null,
      recordId: null,
      trustPath: null,
    };
  }
  const clock = ownDataValue(context.record, 'clock');
  return {
    clockSource: ownDataValue(clock, 'kind'),
    clockUnit: ownDataValue(clock, 'unit'),
    clockDomain: ownDataValue(clock, 'domainId'),
    clockSourceManifestId: ownDataValue(clock, 'sourceManifestId'),
    recordId: context.validation.recomputedRecordId,
    trustPath: context.trustPath,
  };
}

function unavailableDuration(reason, {
  context = null,
  legacyValuesMs = [],
  validationGaps = null,
} = {}) {
  const clock = context ? trustedClockMetadata(context) : trustedClockMetadata({ valid: false });
  const gaps = validationGaps ?? context?.gaps ?? [];
  return {
    state: 'unavailable',
    durationMs: null,
    duration_ms: null,
    durationNs: null,
    duration_ns: null,
    reason,
    endpointPairs: [],
    endpoint_pairs: [],
    clockSource: clock.clockSource,
    clock_source: clock.clockSource,
    clockUnit: clock.clockUnit,
    clock_unit: clock.clockUnit,
    clockDomain: clock.clockDomain,
    clock_domain: clock.clockDomain,
    clockSourceManifestId: clock.clockSourceManifestId,
    clock_source_manifest_id: clock.clockSourceManifestId,
    timingRecordId: clock.recordId,
    timing_record_id: clock.recordId,
    trustPath: clock.trustPath,
    trust_path: clock.trustPath,
    validationGaps: [...gaps],
    validation_gaps: [...gaps],
    legacyValuesMs: [...legacyValuesMs],
    legacy_values_ms: [...legacyValuesMs],
  };
}

function measuredDuration(context, durationNs, endpointPairs) {
  const durationMs = nsToFiniteMs(durationNs);
  const clock = trustedClockMetadata(context);
  if (durationMs === null) {
    return unavailableDuration('validated_v3_duration_not_finite', { context });
  }
  if (
    !Array.isArray(endpointPairs)
    || endpointPairs.length === 0
    || typeof clock.clockDomain !== 'string'
  ) {
    return unavailableDuration('validated_v3_endpoint_pairs_unavailable', { context });
  }
  let derivedDurationNs = 0n;
  const checkedPairs = [];
  for (const pair of endpointPairs) {
    if (pair === null || typeof pair !== 'object' || Array.isArray(pair)) {
      return unavailableDuration('validated_v3_endpoint_pair_invalid', { context });
    }
    const startNs = canonicalNs(ownDataValue(pair, 'startNs'));
    const endNs = canonicalNs(ownDataValue(pair, 'endNs'));
    const clockDomain = ownDataValue(pair, 'clockDomain');
    if (
      startNs === null
      || endNs === null
      || clockDomain !== clock.clockDomain
      || BigInt(endNs) < BigInt(startNs)
    ) {
      return unavailableDuration('validated_v3_endpoint_pair_invalid', { context });
    }
    derivedDurationNs += BigInt(endNs) - BigInt(startNs);
    checkedPairs.push({ startNs, endNs, clockDomain });
  }
  if (derivedDurationNs !== BigInt(durationNs)) {
    return unavailableDuration('validated_v3_endpoint_duration_mismatch', { context });
  }
  return {
    state: 'measured',
    durationMs,
    duration_ms: durationMs,
    durationNs,
    duration_ns: durationNs,
    reason: null,
    endpointPairs: checkedPairs.map((pair) => ({ ...pair })),
    endpoint_pairs: checkedPairs.map((pair) => ({
      start_ns: pair.startNs,
      end_ns: pair.endNs,
      clock_domain: pair.clockDomain,
    })),
    clockSource: clock.clockSource,
    clock_source: clock.clockSource,
    clockUnit: clock.clockUnit,
    clock_unit: clock.clockUnit,
    clockDomain: clock.clockDomain,
    clock_domain: clock.clockDomain,
    clockSourceManifestId: clock.clockSourceManifestId,
    clock_source_manifest_id: clock.clockSourceManifestId,
    timingRecordId: clock.recordId,
    timing_record_id: clock.recordId,
    trustPath: clock.trustPath,
    trust_path: clock.trustPath,
    validationGaps: [],
    validation_gaps: [],
    legacyValuesMs: null,
    legacy_values_ms: null,
  };
}

function phaseTiming(context, phaseName, legacyValuesMs = []) {
  if (!context.valid) {
    return unavailableDuration(context.reason, { context, legacyValuesMs });
  }
  const durationNs = context.validation.recomputedSummary.phaseDurationNs[phaseName];
  if (durationNs === null) {
    return unavailableDuration(`validated_v3_phase_unavailable:${phaseName}`, {
      context,
      legacyValuesMs,
    });
  }
  const endpointPairs = phaseEndpointPairs(context.record, phaseName);
  if (endpointPairs === null) {
    return unavailableDuration(`validated_v3_phase_endpoints_unavailable:${phaseName}`, {
      context,
      legacyValuesMs,
    });
  }
  return measuredDuration(context, durationNs, endpointPairs);
}

function boundaryValue(record, field) {
  const boundary = ownDataValue(record, field);
  if (boundary === null || boundary === MISSING || boundary === REJECTED) return null;
  const monotonicNs = canonicalNs(ownDataValue(boundary, 'monotonicNs'));
  const clockDomain = ownDataValue(boundary, 'clockDomainId');
  const recordClockDomain = ownDataValue(ownDataValue(record, 'clock'), 'domainId');
  return monotonicNs !== null && clockDomain === recordClockDomain
    ? { monotonicNs, clockDomain }
    : null;
}

function intervalTiming(context, summaryField, endpoints, legacyValuesMs = []) {
  if (!context.valid) {
    return unavailableDuration(context.reason, { context, legacyValuesMs });
  }
  const durationNs = context.validation.recomputedSummary[summaryField];
  if (durationNs === null) {
    return unavailableDuration(`validated_v3_interval_unavailable:${summaryField}`, {
      context,
      legacyValuesMs,
    });
  }
  const endpointPairs = endpoints(context.record);
  if (endpointPairs === null || endpointPairs.length === 0) {
    return unavailableDuration(`validated_v3_interval_endpoints_unavailable:${summaryField}`, {
      context,
      legacyValuesMs,
    });
  }
  return measuredDuration(context, durationNs, endpointPairs);
}

function endpointIntervalTiming(context, startEndpoint, endEndpoint, unavailableReason) {
  if (!context.valid) return unavailableDuration(context.reason, { context });
  const start = canonicalNs(startEndpoint?.monotonicNs);
  const end = canonicalNs(endEndpoint?.monotonicNs);
  const clockDomain = trustedClockMetadata(context).clockDomain;
  if (
    start === null
    || end === null
    || startEndpoint?.clockDomain !== clockDomain
    || endEndpoint?.clockDomain !== clockDomain
  ) {
    return unavailableDuration(unavailableReason, { context });
  }
  const startValue = BigInt(start);
  const endValue = BigInt(end);
  if (endValue < startValue) {
    return unavailableDuration('validated_v3_endpoint_order_invalid', { context });
  }
  return measuredDuration(context, (endValue - startValue).toString(), [{
    startNs: start,
    endNs: end,
    clockDomain,
  }]);
}

function firstPhaseEndpoint(record, phaseName, endpoint) {
  const pairs = phaseEndpointPairs(record, phaseName);
  if (pairs === null || pairs.length === 0) return null;
  const pair = endpoint === 'start' ? pairs[0] : pairs[pairs.length - 1];
  return {
    monotonicNs: endpoint === 'start' ? pair.startNs : pair.endNs,
    clockDomain: pair.clockDomain,
  };
}

function timingBundle(context, legacy = {}) {
  const total = intervalTiming(
    context,
    'totalValidatorWallNs',
    (record) => phaseEndpointPairs(record, 'total_validator_wall'),
    legacy.total,
  );
  const setupBuild = phaseTiming(context, 'compile', legacy.setupBuild);
  const screenshotCapture = phaseTiming(context, 'visual_capture', legacy.screenshotCapture);
  const dispatchToOutput = intervalTiming(
    context,
    'dispatchToOutputProofNs',
    (record) => phaseEndpointPairs(record, 'dispatch_to_output_proof'),
    legacy.dispatchToOutput,
  );
  const proofFinalization = phaseTiming(context, 'proof_finalization', legacy.proofFinalization);
  const modality = context.valid ? ownDataValue(context.record, 'modality') : null;
  const editToFirstVisual = modality === 'visual'
    ? intervalTiming(
        context,
        'timeToFirstVisibleNs',
        (record) => {
          const start = firstPhaseEndpoint(record, 'total_validator_wall', 'start');
          const end = boundaryValue(record, 'firstVisibleBoundary');
          return start && end ? [{
            startNs: start.monotonicNs,
            endNs: end.monotonicNs,
            clockDomain: start.clockDomain === end.clockDomain ? start.clockDomain : null,
          }] : null;
        },
        legacy.editToFirstVisual,
      )
    : unavailableDuration(
        context.valid
          ? 'validated_v3_interval_not_visual'
          : context.reason,
        { context, legacyValuesMs: legacy.editToFirstVisual },
      );
  const outputToFirstVisual = modality === 'visual'
    ? endpointIntervalTiming(
         context,
         firstPhaseEndpoint(context.record, 'output_ready', 'end'),
         boundaryValue(context.record, 'firstVisibleBoundary'),
        'validated_v3_output_to_first_visible_unavailable',
      )
    : unavailableDuration(
        context.valid
          ? 'validated_v3_interval_not_visual'
          : context.reason,
       { context },
      );
  const timeToFirstOutputReady = modality === 'compute'
    ? intervalTiming(
        context,
        'timeToFirstOutputReadyNs',
        (record) => {
          const start = firstPhaseEndpoint(record, 'total_validator_wall', 'start');
          const end = boundaryValue(record, 'firstOutputReadyBoundary');
          return start && end ? [{
            startNs: start.monotonicNs,
            endNs: end.monotonicNs,
            clockDomain: start.clockDomain === end.clockDomain ? start.clockDomain : null,
          }] : null;
        },
      )
    : unavailableDuration(
        context.valid
          ? 'validated_v3_interval_not_compute'
          : context.reason,
        { context },
      );
  return {
    total,
    setupBuild,
    screenshotCapture,
    dispatchToOutput,
    proofFinalization,
    editToFirstVisual,
    outputToFirstVisual,
    timeToFirstOutputReady,
    discovery: phaseTiming(context, 'discovery'),
    providerAvailability: phaseTiming(context, 'provider_availability'),
    aiSplit: phaseTiming(context, 'ai_split'),
    compile: phaseTiming(context, 'compile'),
    artifactLoad: phaseTiming(context, 'artifact_load'),
    epochPublish: phaseTiming(context, 'epoch_publish', legacy.hotReloadSignal),
    dispatch: phaseTiming(context, 'dispatch'),
    outputReady: phaseTiming(context, 'output_ready'),
    oracleAnalysis: phaseTiming(context, 'oracle_analysis'),
    visualAnalysis: phaseTiming(context, 'visual_analysis'),
    cleanup: phaseTiming(context, 'cleanup'),
  };
}

function durationMs(timing) {
  return timing.state === 'measured' ? timing.durationMs : null;
}

function totalClockEvidence(context, totalTiming) {
  const endpoints = totalTiming.state === 'measured' ? totalTiming.endpointPairs : [];
  const startNs = endpoints[0]?.startNs ?? null;
  const endNs = endpoints[endpoints.length - 1]?.endNs ?? null;
  return {
    metricClock: context.valid ? GPU_HMR_TEST_TIMING_V3_CLOCK : null,
    metric_clock: context.valid ? GPU_HMR_TEST_TIMING_V3_CLOCK : null,
    metricUnit: 'ms',
    metric_unit: 'ms',
    startedMonotonicNs: startNs,
    started_monotonic_ns: startNs,
    finishedMonotonicNs: endNs,
    finished_monotonic_ns: endNs,
    durationMonotonicNs: totalTiming.durationNs,
    duration_monotonic_ns: totalTiming.durationNs,
    durationMonotonicMs: totalTiming.durationMs,
    duration_monotonic_ms: totalTiming.durationMs,
    durationState: totalTiming.state,
    duration_state: totalTiming.state,
    durationReason: totalTiming.reason,
    duration_reason: totalTiming.reason,
    durationTiming: totalTiming,
    duration_timing: totalTiming,
    clockDomain: totalTiming.clockDomain,
    clock_domain: totalTiming.clockDomain,
    clockSourceManifestId: totalTiming.clockSourceManifestId,
    clock_source_manifest_id: totalTiming.clockSourceManifestId,
    timingRecordId: totalTiming.timingRecordId,
    timing_record_id: totalTiming.timingRecordId,
    trustPath: totalTiming.trustPath,
    trust_path: totalTiming.trustPath,
  };
}

function normalizedTimingFields(bundle) {
  const normalized = {
    staticDiscoveryTimeMs: durationMs(bundle.discovery),
    aiContractSynthesisTimeMs: durationMs(bundle.aiSplit),
    modelAvailabilityCheckTimeMs: durationMs(bundle.providerAvailability),
    artifactHashTimeMs: null,
    adapterGenerationTimeMs: null,
    deviceCompileWallTimeMs: durationMs(bundle.compile),
    artifactLoadTimeMs: durationMs(bundle.artifactLoad),
    epochPublishTimeMs: durationMs(bundle.epochPublish),
    dispatchTraceTimeMs: durationMs(bundle.dispatch),
    runtimeProbeTimeMs: durationMs(bundle.outputReady),
    timeToFirstOutputReadyMs: durationMs(bundle.timeToFirstOutputReady),
    oracleAnalysisTimeMs: durationMs(bundle.oracleAnalysis),
    triggerToVisibleTimeMs: durationMs(bundle.editToFirstVisual),
    screenshotCaptureTimeMs: durationMs(bundle.screenshotCapture),
    dispatchToOutputProofTimeMs: durationMs(bundle.dispatchToOutput),
    totalValidatorWallTimeMs: durationMs(bundle.total),
  };
  return {
    ...normalized,
    snake_case: {
      static_discovery_time: normalized.staticDiscoveryTimeMs,
      ai_contract_synthesis_time: normalized.aiContractSynthesisTimeMs,
      model_availability_check_time: normalized.modelAvailabilityCheckTimeMs,
      artifact_hash_time: normalized.artifactHashTimeMs,
      adapter_generation_time: normalized.adapterGenerationTimeMs,
      device_compile_wall_time: normalized.deviceCompileWallTimeMs,
      artifact_load_time: normalized.artifactLoadTimeMs,
      epoch_publish_time: normalized.epochPublishTimeMs,
      dispatch_trace_time: normalized.dispatchTraceTimeMs,
      runtime_probe_time: normalized.runtimeProbeTimeMs,
      time_to_first_output_ready: normalized.timeToFirstOutputReadyMs,
      oracle_analysis_time: normalized.oracleAnalysisTimeMs,
      trigger_to_visible_time: normalized.triggerToVisibleTimeMs,
      screenshot_capture_time: normalized.screenshotCaptureTimeMs,
      dispatch_to_output_proof_time: normalized.dispatchToOutputProofTimeMs,
      total_validator_wall_time: normalized.totalValidatorWallTimeMs,
    },
  };
}

function normalizeStatus(value) {
  if (typeof value !== 'string') return null;
  if (['pass', 'passed', 'completed', 'accepted', 'success'].includes(value)) return 'pass';
  if (['fail', 'failed', 'error'].includes(value)) return 'fail';
  if (['refused', 'refusal', 'blocked'].includes(value)) return 'refused';
  return null;
}

function outcomeClaims(report) {
  const accepted = resolvePrimitiveAliases(
    [report],
    [
      'accepted', 'isAccepted', 'is_accepted', 'reportedAccepted', 'reported_accepted',
      'gpuHmrSuccess', 'gpu_hmr_success',
    ],
    (value) => typeof value === 'boolean' ? value : null,
  );
  const failed = resolvePrimitiveAliases(
    [report],
    ['failed', 'isFailed', 'is_failed', 'reportedFailed', 'reported_failed'],
    (value) => typeof value === 'boolean' ? value : null,
  );
  const status = resolvePrimitiveAliases(
    [report],
    ['status', 'reportedStatus', 'reported_status', 'outcome', 'result'],
    normalizeStatus,
  );
  if (
    (accepted.present && !accepted.valid)
    || (failed.present && !failed.valid)
    || (status.present && !status.valid)
  ) {
    return {
      status: 'refused',
      conflict: true,
      reason: 'outcome_alias_conflict_or_invalid',
      source: 'conflicting_reported_outcome_fields',
    };
  }
  const claims = [];
  if (accepted.valid) claims.push(accepted.value ? 'pass' : 'fail');
  if (failed.valid) claims.push(failed.value ? 'fail' : 'pass');
  if (status.valid) claims.push(status.value);
  if (new Set(claims).size > 1) {
    return {
      status: 'refused',
      conflict: true,
      reason: 'outcome_claim_conflict',
      source: 'conflicting_reported_outcome_fields',
    };
  }
  return {
    status: claims[0] ?? null,
    conflict: false,
    reason: null,
    source: claims.length > 0 ? 'descriptor_checked_reported_outcome_fields' : null,
  };
}

function telemetryAuthority(outcome) {
  return {
    telemetryOnly: true,
    telemetry_only: true,
    timingOnly: true,
    timing_only: true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    evidenceAuthority: GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
    evidence_authority: GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
    proofVerdict: 'not_evaluated_by_timing_summary',
    proof_verdict: 'not_evaluated_by_timing_summary',
    reportedStatus: outcome.status,
    reported_status: outcome.status,
    reportedAcceptanceSource: outcome.source,
    reported_acceptance_source: outcome.source,
    outcomeConflict: outcome.conflict,
    outcome_conflict: outcome.conflict,
    outcomeConflictReason: outcome.reason,
    outcome_conflict_reason: outcome.reason,
  };
}

function reportedAccepted(outcome) {
  if (outcome.status === 'pass') return true;
  if (outcome.status === 'fail' || outcome.status === 'refused') return false;
  return null;
}

function reportedEvidence(outcome, source) {
  const accepted = reportedAccepted(outcome);
  return {
    reportedAccepted: accepted,
    reported_accepted: accepted,
    evidenceAuthority: GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
    evidence_authority: GPU_HMR_TIMING_TELEMETRY_AUTHORITY,
    proofVerdict: 'not_evaluated_by_timing_summary',
    proof_verdict: 'not_evaluated_by_timing_summary',
    reportedAcceptanceSource: source,
    reported_acceptance_source: source,
  };
}

function primitiveAlias(object, aliases) {
  const resolved = resolvePrimitiveAliases(
    [object],
    aliases,
    (value) => (
      typeof value === 'string'
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    ) ? value : null,
  );
  return resolved.valid ? resolved.value : null;
}

function metricScope(report, fallback = 'hot_delta_1') {
  return primitiveAlias(report, ['metricScope', 'metric_scope']) ?? fallback;
}

function cacheState(report, fallback = 'unknown') {
  return primitiveAlias(report, ['cacheState', 'cache_state']) ?? fallback;
}

function phase(name, timing, source) {
  return {
    name,
    wallMs: durationMs(timing),
    source,
    timingState: timing.state,
    timing_state: timing.state,
    timing,
  };
}

function unavailableField(context, reason, values = []) {
  return unavailableDuration(reason, { context, legacyValuesMs: values });
}

function materialOutcome(report, reportInspection) {
  return reportInspection.valid
    ? outcomeClaims(report)
    : {
        status: 'refused',
        conflict: true,
        reason: reportInspection.reason,
        source: 'descriptor_checked_report_material_rejection',
      };
}

function commonMetrics({
  report,
  timingTrust,
  source,
  profileId = null,
  projectName = null,
  proofMode = null,
  scopeFallback = 'hot_delta_1',
  cacheFallback = 'unknown',
  legacy = {},
  modelProvenance = null,
  diagnosticInspection = { valid: true, reason: null, gaps: [] },
}) {
  const reportInspection = inspectBoundedDataGraph(
    report,
    'report_material',
    REPORT_GRAPH_LIMITS,
  );
  const safeReport = reportInspection.valid ? report : EMPTY_DATA_OBJECT;
  const outcome = materialOutcome(safeReport, reportInspection);
  const context = validateTrustedV3(
    timingTrust,
    safeReport,
    outcome,
    reportInspection,
  );
  const diagnosticMetadata = {
    state: diagnosticInspection.valid ? 'available' : 'unavailable',
    reason: diagnosticInspection.reason,
    gaps: [...diagnosticInspection.gaps],
    timingAuthority: false,
    timing_authority: false,
  };
  const bundle = timingBundle(context, legacy);
  const normalizedTimings = normalizedTimingFields(bundle);
  const clockEvidence = totalClockEvidence(context, bundle.total);
  const sourceWriteTiming = unavailableField(
    context,
    'validated_v3_source_write_phase_unavailable',
    legacy.sourceWrite,
  );
  const beforeCaptureTiming = unavailableField(
    context,
    'validated_v3_before_capture_interval_unavailable',
    legacy.beforeCapture,
  );
  const afterCaptureTiming = unavailableField(
    context,
    'validated_v3_after_capture_interval_unavailable',
    legacy.afterCapture,
  );
  const scope = metricScope(safeReport, scopeFallback);
  const cache = cacheState(safeReport, cacheFallback);
  return {
    schemaVersion: GPU_HMR_TIMING_METRICS_SCHEMA_VERSION,
    source,
    ...telemetryAuthority(outcome),
    metricClock: clockEvidence.metricClock,
    metric_clock: clockEvidence.metric_clock,
    metricUnit: 'ms',
    metric_unit: 'ms',
    metricScope: scope,
    metric_scope: scope,
    cacheState: cache,
    cache_state: cache,
    profileId,
    projectName,
    proofMode,
    status: outcome.status,
    totalWallMs: durationMs(bundle.total),
    totalWallTiming: bundle.total,
    total_wall_timing: bundle.total,
    setupBuildMs: durationMs(bundle.setupBuild),
    setupBuildTiming: bundle.setupBuild,
    setup_build_timing: bundle.setupBuild,
    adapterBuildMs: null,
    runtimeReadyMs: durationMs(bundle.outputReady),
    timeToFirstOutputReadyMs: durationMs(bundle.timeToFirstOutputReady),
    timeToFirstOutputReadyTiming: bundle.timeToFirstOutputReady,
    time_to_first_output_ready_ms: durationMs(bundle.timeToFirstOutputReady),
    time_to_first_output_ready_timing: bundle.timeToFirstOutputReady,
    initialCompileWallMs: durationMs(bundle.compile),
    sourceWriteMs: null,
    sourceWriteTiming,
    source_write_timing: sourceWriteTiming,
    modelAvailabilityCheckMs: durationMs(bundle.providerAvailability),
    modelProvenance,
    aiDeltaWallMs: durationMs(bundle.aiSplit),
    hotHmrCompileWallMs: durationMs(bundle.compile),
    sameProcessLiveRecompileMs: durationMs(bundle.compile),
    sameProcessTriggerWaitMs: null,
    hotReloadSignalMs: durationMs(bundle.epochPublish),
    hotReloadSignalTiming: bundle.epochPublish,
    hot_reload_signal_timing: bundle.epochPublish,
    editToFirstVisualMs: durationMs(bundle.editToFirstVisual),
    editToFirstVisualTiming: bundle.editToFirstVisual,
    edit_to_first_visual_timing: bundle.editToFirstVisual,
    outputToFirstVisualMs: durationMs(bundle.outputToFirstVisual),
    outputToFirstVisualTiming: bundle.outputToFirstVisual,
    output_to_first_visual_timing: bundle.outputToFirstVisual,
    dispatchToOutputProofMs: durationMs(bundle.dispatchToOutput),
    dispatchToOutputProofTiming: bundle.dispatchToOutput,
    dispatch_to_output_proof_timing: bundle.dispatchToOutput,
    proofFinalizationMs: durationMs(bundle.proofFinalization),
    proofFinalizationTiming: bundle.proofFinalization,
    proof_finalization_timing: bundle.proofFinalization,
    beforeCaptureMs: null,
    beforeCaptureTiming,
    before_capture_timing: beforeCaptureTiming,
    afterCaptureMs: null,
    afterCaptureTiming,
    after_capture_timing: afterCaptureTiming,
    visualDiffMs: durationMs(bundle.visualAnalysis),
    teardownMs: durationMs(bundle.cleanup),
    normalizedTimings,
    normalized_timings: normalizedTimings.snake_case,
    clockEvidence,
    clock_evidence: clockEvidence,
    screenshotCaptureMs: durationMs(bundle.screenshotCapture),
    screenshotCaptureTiming: bundle.screenshotCapture,
    screenshot_capture_timing: bundle.screenshotCapture,
    diagnosticMetadata,
    diagnostic_metadata: diagnosticMetadata,
    timingV3Validation: {
      state: context.valid ? 'validated' : 'unavailable',
      reason: context.reason,
      gaps: [...context.gaps],
      trustPath: context.trustPath,
      timingOnly: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    },
    timing_v3_validation: {
      state: context.valid ? 'validated' : 'unavailable',
      reason: context.reason,
      gaps: [...context.gaps],
      trust_path: context.trustPath,
      timing_only: true,
      accepted_for_gpu_hmr: false,
      gpu_hmr_success: false,
    },
    phases: [
      phase('discovery', bundle.discovery, 'validated_v3:discovery'),
      phase('provider_availability', bundle.providerAvailability, 'validated_v3:provider_availability'),
      phase('ai_split', bundle.aiSplit, 'validated_v3:ai_split'),
      phase('setup_build', bundle.setupBuild, 'validated_v3:compile'),
      phase('artifact_load', bundle.artifactLoad, 'validated_v3:artifact_load'),
      phase('epoch_publish', bundle.epochPublish, 'validated_v3:epoch_publish'),
      phase('dispatch', bundle.dispatch, 'validated_v3:dispatch'),
      phase('output_ready', bundle.outputReady, 'validated_v3:output_ready'),
      phase(
        'time_to_first_output_ready',
        bundle.timeToFirstOutputReady,
        'validated_v3:total_validator_wall:first_output_ready_boundary',
      ),
      phase('dispatch_to_output_proof', bundle.dispatchToOutput, 'validated_v3:dispatch_to_output_proof'),
      phase('edit_to_first_visual', bundle.editToFirstVisual, 'validated_v3:first_visible_boundary'),
      phase('output_to_first_visual', bundle.outputToFirstVisual, 'validated_v3:output_ready:first_visible_boundary'),
      phase('screenshot_capture', bundle.screenshotCapture, 'validated_v3:visual_capture'),
      phase('oracle_analysis', bundle.oracleAnalysis, 'validated_v3:oracle_analysis'),
      phase('proof_finalization', bundle.proofFinalization, 'validated_v3:proof_finalization'),
      phase('cleanup', bundle.cleanup, 'validated_v3:cleanup'),
      phase('total_validator_wall', bundle.total, 'validated_v3:total_validator_wall'),
    ],
    _outcome: outcome,
  };
}

function withoutInternalOutcome(metrics) {
  const { _outcome, ...publicMetrics } = metrics;
  return { publicMetrics, outcome: _outcome };
}

function genericTimingConfiguration(options) {
  const inspection = inspectBoundedDataGraph(
    options,
    'timing_metrics_options',
    OPTIONS_GRAPH_LIMITS,
  );
  if (!inspection.valid) {
    return {
      inspection,
      config: {
        source: 'trusted_v3_generic',
      },
    };
  }
  const optionObject = options !== null
    && typeof options === 'object'
    && !Array.isArray(options)
    ? options
    : EMPTY_DATA_OBJECT;
  const value = (key, fallback) => {
    const candidate = ownDataValue(optionObject, key);
    return candidate === MISSING ? fallback : candidate;
  };
  const stringValue = (key, fallback) => {
    const candidate = value(key, fallback);
    return nonemptyString(candidate) === REJECTED ? fallback : candidate;
  };
  const nullableDiagnostic = (key) => {
    const candidate = value(key, null);
    return candidate === null
      || typeof candidate === 'string'
      || typeof candidate === 'boolean'
      || (typeof candidate === 'number' && Number.isFinite(candidate))
      ? candidate
      : null;
  };
  const legacy = value('legacy', EMPTY_DATA_OBJECT);
  const modelProvenance = value('modelProvenance', null);
  const config = {
    source: stringValue('source', 'trusted_v3_generic'),
    profileId: nullableDiagnostic('profileId'),
    projectName: nullableDiagnostic('projectName'),
    proofMode: nullableDiagnostic('proofMode'),
    scopeFallback: stringValue('scopeFallback', 'hot_delta_1'),
    cacheFallback: stringValue('cacheFallback', 'unknown'),
    legacy: legacy !== null && typeof legacy === 'object' && !Array.isArray(legacy)
      ? legacy
      : EMPTY_DATA_OBJECT,
    modelProvenance: modelProvenance !== null
      && typeof modelProvenance === 'object'
      && !Array.isArray(modelProvenance)
      ? modelProvenance
      : null,
  };
  return { inspection, config };
}

export function timingMetricsFromTrustedV3(report, timingTrust, options = EMPTY_DATA_OBJECT) {
  const { config, inspection } = genericTimingConfiguration(options);
  return withoutInternalOutcome(commonMetrics({
    report,
    timingTrust,
    ...config,
    diagnosticInspection: inspection,
  })).publicMetrics;
}

function inspectedReport(report) {
  const inspection = inspectBoundedDataGraph(
    report,
    'report_material',
    REPORT_GRAPH_LIMITS,
  );
  return {
    inspection,
    safeReport: inspection.valid ? report : EMPTY_DATA_OBJECT,
    outcome: materialOutcome(inspection.valid ? report : EMPTY_DATA_OBJECT, inspection),
  };
}

function webGpuLegacy(proof) {
  const timings = dataObject(proof, ['timings']);
  return {
    total: legacyValues(legacyNsAlias(timings, ['total_validator_wall_time', 'totalValidatorWallTime'])),
    setupBuild: [],
    screenshotCapture: legacyValues(legacyNsAlias(timings, ['screenshot_capture_time', 'screenshotCaptureTime'])),
    dispatchToOutput: legacyValues(legacyNsAlias(timings, ['dispatch_to_output_proof_time', 'dispatchToOutputProofTime'])),
    proofFinalization: legacyValues(legacyNsAlias(timings, ['proof_finalization_time', 'proofFinalizationTime'])),
    editToFirstVisual: legacyValues(legacyNsAlias(timings, ['trigger_to_visible_time', 'triggerToVisibleTime'])),
    hotReloadSignal: legacyValues(legacyNsAlias(timings, ['epoch_publish_time', 'epochPublishTime'])),
    sourceWrite: [],
    beforeCapture: [],
    afterCapture: [],
  };
}

function webGpuModelProvenance(proof) {
  const ledgerRecord = dataObject(proof, ['proofLedger', 'records', '0']);
  return consistentDataObjectCandidates(
    dataObjectAlias(proof, ['modelProvenance', 'model_provenance']),
    dataObjectAlias(ledgerRecord, ['modelProvenance', 'model_provenance']),
  );
}

export function webGpuRuntimeVisualTimingMetrics(proof, timingTrust) {
  const { safeReport, outcome } = inspectedReport(proof);
  const publicMetrics = timingMetricsFromTrustedV3(proof, timingTrust, {
    source: 'webgpu_runtime_visual',
    profileId: dataPath(safeReport, ['profile', 'id']),
    projectName: 'WebGPU runtime visual proof',
    proofMode: 'webgpu_wgsl_runtime_visual',
    cacheFallback: 'pipeline_cache_warm',
    legacy: webGpuLegacy(safeReport),
    modelProvenance: webGpuModelProvenance(safeReport),
  });
  const metrics = dataObject(safeReport, ['metrics']);
  return {
    ...publicMetrics,
    visualEvidence: {
      screenshotCount: 3,
      changedPixelRatio: finiteNumber(ownDataValue(metrics, 'changedPixelRatio')),
      meanAbsDelta8bit: finiteNumber(ownDataValue(metrics, 'meanAbsDelta8bit')),
      visiblePixelCount: finiteNumber(ownDataValue(metrics, 'visiblePixelCount')),
      accepted: reportedAccepted(outcome),
      ...reportedEvidence(outcome, outcome.source),
    },
  };
}

function computeEvidenceForReport(proof, outcome) {
  const artifacts = dataObjectAlias(
    proof,
    ['computeOracleArtifacts', 'compute_oracle_artifacts'],
  );
  const renderedCardPng = primitiveAlias(artifacts, ['rendered_card_png', 'renderedCardPng']);
  const accepted = reportedAccepted(outcome);
  return {
    computeEvidence: {
      rawReadbackHash: primitiveAlias(artifacts, ['raw_readback_hash', 'rawReadbackHash']),
      rawReadbackByteLength: primitiveAlias(
        artifacts,
        ['raw_readback_byte_length', 'rawReadbackByteLength'],
      ),
      deterministicSliceHash: primitiveAlias(
        artifacts,
        ['deterministic_slice_hash', 'deterministicSliceHash'],
      ),
      renderedCardPng,
      computeCardAccepted: Boolean(renderedCardPng) && accepted === true,
      accepted,
      ...reportedEvidence(outcome, outcome.source),
    },
    visualEvidence: {
      screenshotCount: 0,
      changedPixelRatio: null,
      meanAbsDelta8bit: null,
      visiblePixelCount: null,
      accepted: false,
      ...reportedEvidence(
        { status: 'fail' },
        'compute_readback_no_runtime_frame_visual',
      ),
      reason: 'compute_readback_has_no_runtime_frame_visual_proof',
    },
  };
}

export function webGpuRuntimeComputeTimingMetrics(proof, timingTrust) {
  const { safeReport, outcome } = inspectedReport(proof);
  const publicMetrics = timingMetricsFromTrustedV3(proof, timingTrust, {
    source: 'webgpu_runtime_compute',
    profileId: dataPath(safeReport, ['profile', 'id']),
    projectName: 'WebGPU runtime compute proof',
    proofMode: 'webgpu_wgsl_runtime_compute',
    cacheFallback: 'pipeline_cache_warm',
    legacy: webGpuLegacy(safeReport),
    modelProvenance: webGpuModelProvenance(safeReport),
  });
  return {
    ...publicMetrics,
    ...computeEvidenceForReport(safeReport, outcome),
  };
}

export function hipModuleRuntimeTimingMetrics(proof, timingTrust) {
  const { safeReport, outcome } = inspectedReport(proof);
  const base = timingMetricsFromTrustedV3(proof, timingTrust, {
    source: 'hip_module_runtime',
    profileId: dataPath(safeReport, ['profile', 'id']),
    projectName: 'HIP module runtime compute proof',
    proofMode: 'hip_module_runtime_readback',
    cacheFallback: 'compiler_cache_warm',
    legacy: webGpuLegacy(safeReport),
    modelProvenance: webGpuModelProvenance(safeReport),
  });
  const nativeApiCounts = dataPath(safeReport, ['nativeHipApiEvidence', 'counts']);
  const deviceIdentity = dataPath(safeReport, ['runtimeTrace', 'device']);
  const hsacoBeforeHash = primitiveAlias(
    dataObject(safeReport, ['compiler']),
    ['hsacoBeforeHash'],
  );
  const hsacoAfterHash = primitiveAlias(
    dataObject(safeReport, ['compiler']),
    ['hsacoAfterHash'],
  );
  return {
    ...base,
    ...computeEvidenceForReport(safeReport, outcome),
    hipEvidence: {
      nativeApiCounts,
      deviceIdentity,
      hsacoBeforeHash,
      hsacoAfterHash,
      accepted: reportedAccepted(outcome),
      ...reportedEvidence(outcome, outcome.source),
    },
    hip_evidence: {
      native_api_counts: nativeApiCounts,
      device_identity: deviceIdentity,
      hsaco_before_hash: hsacoBeforeHash,
      hsaco_after_hash: hsacoAfterHash,
      accepted: reportedAccepted(outcome),
      ...reportedEvidence(outcome, outcome.source),
    },
  };
}

function externalLegacy(report) {
  const timings = dataObject(report, ['timings']);
  const screenshots = plainDataArray(dataPath(report, ['screenshots'])) ?? [];
  const before = screenshots.find((shot) => ownDataValue(shot, 'label') === 'before');
  const after = screenshots.find((shot) => ownDataValue(shot, 'label') === 'after');
  return {
    total: legacyValues(
      legacyMsAlias(timings, ['totalMs']),
      legacyMsAlias(report, ['duration_ms']),
    ),
    setupBuild: legacyValues(legacyMsAlias(timings, ['buildMs'])),
    screenshotCapture: legacyValues(
      legacyMsAlias(before, ['elapsedMs']),
      legacyMsAlias(after, ['elapsedMs']),
    ),
    dispatchToOutput: [],
    proofFinalization: legacyValues(legacyMsAlias(timings, ['proofFinalizationMs'])),
    editToFirstVisual: legacyValues(legacyMsAlias(timings, ['editToScreenshotMs'])),
    hotReloadSignal: legacyValues(
      legacyMsAlias(timings, ['editToRuntimeSignalMs', 'editToMcpHmrMs']),
    ),
    sourceWrite: legacyValues(legacyMsAlias(timings, ['sourceWriteMs'])),
    beforeCapture: legacyValues(legacyMsAlias(before, ['elapsedMs'])),
    afterCapture: legacyValues(legacyMsAlias(after, ['elapsedMs'])),
  };
}

function externalModelProvenance(report) {
  const mcp = dataObject(report, ['mcp']);
  return consistentDataObjectCandidates(
    dataObjectAlias(report, ['modelProvenance', 'model_provenance']),
    dataObjectAlias(mcp, ['modelProvenance', 'model_provenance']),
  );
}

export function externalProjectTimingMetrics(report, timingTrust) {
  const { safeReport, outcome } = inspectedReport(report);
  const publicMetrics = timingMetricsFromTrustedV3(report, timingTrust, {
    source: 'external_project_profile',
    profileId: dataPath(safeReport, ['profile', 'id']),
    projectName: dataPath(safeReport, ['profile', 'project', 'name']),
    proofMode: primitiveAlias(safeReport, ['proofMode', 'proof_mode']),
    legacy: externalLegacy(safeReport),
    modelProvenance: externalModelProvenance(safeReport),
  });
  const screenshots = plainDataArray(dataPath(safeReport, ['screenshots'])) ?? [];
  return {
    ...publicMetrics,
    visualEvidence: {
      screenshotCount: screenshots.length,
      changedPixelRatio: finiteNumber(dataPath(safeReport, ['visualDiff', 'changedPixelRatio'])),
      meanAbsDelta8bit: finiteNumber(dataPath(safeReport, ['visualDiff', 'meanAbsDelta8bit'])),
      accepted: reportedAccepted(outcome),
      ...reportedEvidence(outcome, outcome.source),
    },
  };
}

function hiprtLegacy(proof) {
  const timings = dataObject(proof, ['timings']);
  const baseline = dataObject(proof, ['runtime', 'baseline']);
  const changed = dataObject(proof, ['runtime', 'changed']);
  return {
    total: legacyValues(legacyMsAlias(timings, ['totalWallMs'])),
    setupBuild: legacyValues(legacyMsAlias(timings, ['sameProcessAdapterBuildMs'])),
    screenshotCapture: legacyValues(
      legacyMsAlias(baseline, ['hostWallMs']),
      legacyMsAlias(changed, ['hostWallMs']),
    ),
    dispatchToOutput: [],
    proofFinalization: legacyValues(legacyMsAlias(timings, ['proofFinalizationMs'])),
    editToFirstVisual: legacyValues(
      legacyMsAlias(changed, ['totalHostWallMs', 'hostWallMs']),
      legacyMsAlias(timings, ['changedHostWallMs', 'changedRunMs']),
    ),
    hotReloadSignal: legacyValues(
      legacyMsAlias(changed, ['triggerTouchMs']),
      legacyMsAlias(timings, ['sameProcessTriggerWaitMs']),
    ),
    sourceWrite: [],
    beforeCapture: legacyValues(legacyMsAlias(baseline, ['hostWallMs'])),
    afterCapture: legacyValues(legacyMsAlias(changed, ['hostWallMs'])),
  };
}

function hiprtModelProvenance(proof) {
  const runtime = dataObject(proof, ['runtime']);
  return consistentDataObjectCandidates(
    dataObjectAlias(proof, ['modelProvenance', 'model_provenance']),
    dataObjectAlias(runtime, ['modelProvenance', 'model_provenance']),
  );
}

export function hiprtWarmTimingMetrics(proof, timingTrust) {
  const { safeReport, outcome } = inspectedReport(proof);
  const publicMetrics = timingMetricsFromTrustedV3(proof, timingTrust, {
    source: 'hiprt_warm_runtime',
    profileId: dataPath(safeReport, ['profile', 'id'])
      ?? dataPath(safeReport, ['runtimeProfile', 'id']),
    projectName: dataPath(safeReport, ['repo', 'target']),
    proofMode: primitiveAlias(dataObject(safeReport, ['timings']), ['mode'])
      ?? primitiveAlias(safeReport, ['mode']),
    cacheFallback: 'compiler_cache_warm',
    legacy: hiprtLegacy(safeReport),
    modelProvenance: hiprtModelProvenance(safeReport),
  });
  return {
    ...publicMetrics,
    visualEvidence: {
      screenshotCount: 2,
      changedPixelRatio: finiteNumber(
        dataPath(safeReport, ['diff', 'changedPixelRatioThreshold4']),
      ),
      meanAbsDelta8bit: finiteNumber(dataPath(safeReport, ['diff', 'meanAbsDelta8bit'])),
      accepted: reportedAccepted(outcome),
      ...reportedEvidence(outcome, outcome.source),
    },
  };
}

function strictKeyValueTiming(text, key) {
  if (typeof text !== 'string') return null;
  const match = new RegExp(`(?:^|\\s)${key}=((?:0|[1-9][0-9]*)(?:\\.[0-9]+)?)(?=\\s|$)`).exec(text);
  if (!match) return null;
  const milliseconds = Number(match[1]);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function realRocmLegacy(report) {
  const phases = plainDataArray(dataPath(report, ['phases'])) ?? [];
  const upstream = phases.find((item) => ownDataValue(item, 'name') === 'upstream_gpu_build_run');
  const upstreamTimings = ownDataValue(upstream, 'timings');
  const hotSignalValues = phases.flatMap((item) => legacyValues(
    legacyMsAlias(item, ['wait_hmr_elapsed_ms', 'waitHmrElapsedMs']),
    legacyMsAlias(item, ['wait_call_wall_ms', 'waitCallWallMs']),
  ));
  const screenshots = plainDataArray(dataPath(report, ['screenshots'])) ?? [];
  return {
    total: legacyValues(legacyMsAlias(report, ['duration_ms', 'durationMs'])),
    setupBuild: legacyValues(
      strictKeyValueTiming(upstreamTimings, 'configure_ms'),
      strictKeyValueTiming(upstreamTimings, 'build_ms'),
    ),
    screenshotCapture: screenshots.flatMap((shot) => legacyValues(
      legacyMsAlias(shot, ['elapsedMs', 'elapsed_ms']),
    )),
    dispatchToOutput: [],
    proofFinalization: legacyValues(legacyMsAlias(report, ['proof_finalization_ms'])),
    editToFirstVisual: legacyValues(
      legacyMsAlias(report, ['hotSignalMs', 'hot_signal_ms']),
      hotSignalValues,
    ),
    hotReloadSignal: hotSignalValues,
    sourceWrite: [],
    beforeCapture: [],
    afterCapture: [],
  };
}

function realRocmModelProvenance(report) {
  const evidence = dataObject(report, ['evidence']);
  return consistentDataObjectCandidates(
    dataObjectAlias(report, ['modelProvenance', 'model_provenance']),
    dataObjectAlias(evidence, ['ai_model_provenance', 'model_provenance']),
  );
}

export function realRocmTimingMetrics(report, timingTrust) {
  const { safeReport, outcome } = inspectedReport(report);
  const publicMetrics = timingMetricsFromTrustedV3(report, timingTrust, {
    source: 'real_rocm_validation',
    profileId: primitiveAlias(safeReport, ['slug']),
    projectName: primitiveAlias(safeReport, ['target_name', 'targetName']),
    proofMode: dataPath(safeReport, ['hiprt_runtime_probe', 'enabled']) === true
      ? 'real_rocm_hiprt_probe'
      : 'real_rocm',
    legacy: realRocmLegacy(safeReport),
    modelProvenance: realRocmModelProvenance(safeReport),
  });
  const screenshots = plainDataArray(dataPath(safeReport, ['screenshots'])) ?? [];
  const acceptedScreenshotCount = screenshots.filter(
    (shot) => ownDataValue(shot, 'accepted_as_visual_evidence') === true,
  ).length;
  const blockedValidationWaitTiming = unavailableDuration(
    'endpoint_free_blocked_validation_wait_legacy_only',
  );
  return {
    ...publicMetrics,
    blockedValidationWaitMs: null,
    blocked_validation_wait_ms: null,
    blockedValidationWaitTiming,
    blocked_validation_wait_timing: blockedValidationWaitTiming,
    visualEvidence: {
      screenshotCount: screenshots.length,
      acceptedScreenshotCount,
      accepted: acceptedScreenshotCount > 0 && !outcome.conflict,
      ...reportedEvidence(outcome, 'screenshots.accepted_as_visual_evidence'),
    },
  };
}
