import { createHash } from 'node:crypto';

export const GPU_HMR_TEST_TIMING_V3_SCHEMA = 'synthi.gpu_hmr.test_timing.v3';
export const GPU_HMR_TEST_TIMING_V3_SCHEMA_VERSION = 3;
export const GPU_HMR_TEST_TIMING_V3_CLOCK = 'monotonic_ns';
export const GPU_HMR_TEST_TIMING_V3_UNIT = 'nanosecond';
export const GPU_HMR_TEST_TIMING_V3_AUTHORITY =
  'timing_measurement_only_not_gpu_hmr_acceptance';
export const GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON =
  'compute_modality_has_no_visual_phase';
export const GPU_HMR_TEST_TIMING_V3_EXTERNAL_PERSISTENCE_REASON =
  'timing_record_persistence_requires_external_receipt';
export const GPU_HMR_TEST_TIMING_V3_DERIVED_INTERVAL_REASON =
  'authoritative_dispatch_or_oracle_boundary_unavailable';
export const GPU_HMR_TEST_TIMING_V3_CLOCK_SOURCE_SCHEMA =
  'synthi.gpu_hmr.timing_clock_source_manifest.v1';
export const GPU_HMR_TEST_TIMING_V3_PERSISTENCE_RECEIPT_SCHEMA =
  'synthi.gpu_hmr.test_timing_persistence_receipt.v1';
export const GPU_HMR_TEST_TIMING_V3_PERSISTENCE_PLAN_SCHEMA =
  'synthi.gpu_hmr.test_timing_persistence_plan.v1';
export const GPU_HMR_TEST_TIMING_V3_MAX_ATTEMPTS_PER_PHASE = 64;
export const GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS = 32;
export const GPU_HMR_TEST_TIMING_V3_MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const GPU_HMR_TEST_TIMING_V3_MAX_NS_BITS = 128;
export const GPU_HMR_TEST_TIMING_V3_MAX_NS_DIGITS = 39;

export const GPU_HMR_TEST_TIMING_V3_PHASES = Object.freeze([
  'discovery',
  'provider_availability',
  'ai_split',
  'compile',
  'artifact_load',
  'epoch_publish',
  'dispatch',
  'output_ready',
  'oracle_analysis',
  'visual_capture',
  'visual_analysis',
  'dispatch_to_output_proof',
  'retirement',
  'proof_finalization',
  'durable_persistence',
  'cleanup',
  'total_validator_wall',
]);

export const GPU_HMR_TEST_TIMING_V3_DISPOSITIONS = Object.freeze([
  'measured',
  'not_applicable',
  'unavailable',
]);
export const GPU_HMR_TEST_TIMING_V3_RUN_MODES = Object.freeze([
  'cold',
  'warm',
  'hot_delta',
  'negative_edit',
  'refusal',
]);
export const GPU_HMR_TEST_TIMING_V3_SPLIT_MODES = Object.freeze([
  'fresh_ai',
  'reused_ai',
  'not_applicable',
]);
export const GPU_HMR_TEST_TIMING_V3_MODALITIES = Object.freeze([
  'visual',
  'compute',
]);
export const GPU_HMR_TEST_TIMING_V3_OUTCOMES = Object.freeze([
  'completed',
  'refused',
  'failed',
]);
export const GPU_HMR_TEST_TIMING_V3_ATTEMPT_RESULTS = Object.freeze([
  'completed',
  'failed',
]);

const PHASE_SET = new Set(GPU_HMR_TEST_TIMING_V3_PHASES);
const DISPOSITION_SET = new Set(GPU_HMR_TEST_TIMING_V3_DISPOSITIONS);
const RUN_MODE_SET = new Set(GPU_HMR_TEST_TIMING_V3_RUN_MODES);
const SPLIT_MODE_SET = new Set(GPU_HMR_TEST_TIMING_V3_SPLIT_MODES);
const MODALITY_SET = new Set(GPU_HMR_TEST_TIMING_V3_MODALITIES);
const OUTCOME_SET = new Set(GPU_HMR_TEST_TIMING_V3_OUTCOMES);
const ATTEMPT_RESULT_SET = new Set(GPU_HMR_TEST_TIMING_V3_ATTEMPT_RESULTS);
const MEASUREMENT_KIND_SET = new Set(['observed', 'derived']);
const VISUAL_PHASE_SET = new Set(['visual_capture', 'visual_analysis']);
const TERMINAL_PHASE_SET = new Set([
  'proof_finalization',
  'cleanup',
  'total_validator_wall',
]);
const COMPLETED_CORE_PHASE_SET = new Set([
  'compile',
  'artifact_load',
  'epoch_publish',
  'dispatch',
  'output_ready',
  'oracle_analysis',
  'dispatch_to_output_proof',
  'retirement',
]);

const RECORD_KEYS = Object.freeze([
  'schema',
  'schemaVersion',
  'recordId',
  'clock',
  'binding',
  'modality',
  'outcome',
  'authority',
  'timingOnly',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'phases',
  'firstVisibleBoundary',
  'firstOutputReadyBoundary',
  'summary',
]);
const CLOCK_KEYS = Object.freeze([
  'kind',
  'unit',
  'domainId',
  'sourceManifestId',
  'sourceIdentityHash',
]);
const BINDING_KEYS = Object.freeze([
  'runMode',
  'splitMode',
  'modality',
  'outcome',
  'sourceManifestHash',
  'editId',
  'editHash',
  'artifactHash',
  'proofLedgerId',
  'runtimeProofId',
  'runtimeSessionId',
  'processIdentity',
  'clockSourceManifestId',
  'clockSourceIdentityHash',
  'clockDomainId',
]);
const PHASE_KEYS = Object.freeze([
  'phase',
  'disposition',
  'measurementKind',
  'reasonCode',
  'evidenceRefs',
  'attempts',
]);
const ATTEMPT_KEYS = Object.freeze([
  'attempt',
  'result',
  'measurementKind',
  'startNs',
  'endNs',
  'durationNs',
  'clockDomainId',
  'source',
  'evidenceRefs',
]);
const BOUNDARY_KEYS = Object.freeze([
  'kind',
  'monotonicNs',
  'clockDomainId',
  'source',
  'evidenceRefs',
]);
const SUMMARY_KEYS = Object.freeze([
  'phaseDurationNs',
  'phaseAttemptCount',
  'phaseFailedAttemptCount',
  'firstVisibleNs',
  'timeToFirstVisibleNs',
  'firstOutputReadyNs',
  'timeToFirstOutputReadyNs',
  'dispatchToOutputProofNs',
  'totalValidatorWallNs',
]);
const VALIDATION_OPTION_KEYS = Object.freeze([
  'expectedBinding',
  'trustedClockSourceManifest',
]);
const RECORDER_OPTION_KEYS = Object.freeze([
  'clockCapability',
  'binding',
  'totalSource',
  'totalEvidenceRefs',
]);

const CLOCK_SOURCE_MANIFEST_KEYS = Object.freeze([
  'schema',
  'schemaVersion',
  'manifestId',
  'recorderImplementationHash',
  'clockKind',
  'unit',
  'clockDomainId',
  'clockSourceIdentityHash',
  'clockImplementation',
  'testOnly',
  'persistenceEligible',
  'runtimeSessionId',
  'processIdentity',
  'evidenceRefs',
  'authority',
  'timingOnly',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
]);
const CLOCK_SOURCE_INPUT_KEYS = Object.freeze([
  'recorderImplementationHash',
  'clockDomainId',
  'clockSourceIdentityHash',
  'runtimeSessionId',
  'processIdentity',
  'evidenceRefs',
]);
const PERSISTENCE_PLAN_KEYS = Object.freeze([
  'schema',
  'timingRecordId',
  'timingRecordHash',
  'byteLength',
  'byteHash',
  'serializedRecord',
]);
const RECEIPT_KEYS = Object.freeze([
  'schema',
  'schemaVersion',
  'receiptId',
  'timingRecordId',
  'timingRecordHash',
  'writerIdentity',
  'processIdentity',
  'runtimeSessionId',
  'destinationIdentity',
  'byteLength',
  'byteHash',
  'clock',
  'write',
  'readableAfterWrite',
  'authority',
  'timingOnly',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
]);
const RECEIPT_WRITE_KEYS = Object.freeze([
  'startNs',
  'endNs',
  'durationNs',
  'source',
  'evidenceRefs',
]);
const RECEIPT_READ_KEYS = Object.freeze([
  'verified',
  'verifiedAtNs',
  'readerIdentity',
  'observedByteLength',
  'observedByteHash',
  'evidenceRefs',
]);
const RECEIPT_CREATE_KEYS = Object.freeze([
  'persistenceOperation',
  'persistencePlan',
  'timingRecordValidationOptions',
  'writerClockCapability',
  'writerIdentity',
  'destinationIdentity',
  'writeStartReading',
  'writeEndReading',
  'writeSource',
  'writeEvidenceRefs',
  'readableAfterWrite',
]);
const RECEIPT_READ_INPUT_KEYS = Object.freeze([
  'verified',
  'verifiedAtReading',
  'readerIdentity',
  'observedByteLength',
  'observedByteHash',
  'evidenceRefs',
]);
const RECEIPT_VALIDATION_OPTION_KEYS = Object.freeze([
  'expectedPersistencePlan',
  'timingRecordValidationOptions',
  'trustedWriterClockCapability',
  'expectedWriterIdentity',
  'expectedDestinationIdentity',
]);

const PERSISTENCE_OPERATION_INPUT_KEYS = Object.freeze([
  'persistencePlan',
  'timingRecordValidationOptions',
  'writerClockCapability',
  'writerIdentity',
  'destinationIdentity',
]);
const PERSISTENCE_READING_STAGES = Object.freeze([
  'write_start',
  'write_end',
  'read_verify',
]);

const TEST_CLOCK_CAPABILITY_INPUT_KEYS = Object.freeze([
  'now',
  'manifestInput',
]);

const NS_PATTERN = /^(0|[1-9][0-9]*)$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]{0,511}$/;
const REASON_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,255}$/;
const RECORD_ID_PATTERN = /^gpu-hmr-test-timing-v3:sha256:[0-9a-f]{64}$/;
const CLOCK_SOURCE_ID_PATTERN = /^gpu-hmr-timing-clock-source:sha256:[0-9a-f]{64}$/;
const RECEIPT_ID_PATTERN = /^gpu-hmr-timing-persistence-receipt:sha256:[0-9a-f]{64}$/;
const CLOCK_IMPLEMENTATION_HRTIME = 'node_process_hrtime_bigint';
const CLOCK_IMPLEMENTATION_SYNTHETIC = 'synthetic_test_clock';
const INTRINSIC_PROCESS_HRTIME_BIGINT = process.hrtime.bigint.bind(process.hrtime);
const MAX_NS = (1n << BigInt(GPU_HMR_TEST_TIMING_V3_MAX_NS_BITS)) - 1n;
const CLOCK_CAPABILITY_DATA = new WeakMap();
const CLOCK_READING_DATA = new WeakMap();
const PERSISTENCE_OPERATION_DATA = new WeakMap();
const SUCCESS_CLAIM_KEYS = new Set([
  'acceptedforgpuhmr',
  'gpuhmrsuccess',
  'fullruntimeproven',
  'strictruntimeproofaccepted',
  'cansatisfyruntimeproof',
  'cansatisfydispatchproof',
]);
const AUTHORITY_CLAIM_KEYS = new Set([
  'proofauthority',
  'runtimeauthority',
  'dispatchauthority',
  'outputoracleauthority',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pushGap(gaps, gap) {
  if (!gaps.includes(gap)) gaps.push(gap);
}

function plainOwnDataKeys(value, scope, gaps) {
  if (!isObject(value)) {
    pushGap(gaps, `${scope}_not_object`);
    return null;
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    pushGap(gaps, `${scope}_material_invalid`);
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    pushGap(gaps, `${scope}_prototype_invalid`);
    return null;
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    pushGap(gaps, `${scope}_material_invalid`);
    return null;
  }
  if (keys.some((key) => typeof key === 'symbol')) {
    pushGap(gaps, `${scope}_symbol_property_rejected`);
    return null;
  }
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      pushGap(gaps, `${scope}_material_invalid`);
      return null;
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      pushGap(gaps, `${scope}_accessor_property_rejected:${key}`);
      return null;
    }
    if (!descriptor.enumerable) {
      pushGap(gaps, `${scope}_non_enumerable_property_rejected:${key}`);
      return null;
    }
  }
  return keys;
}

function exactKeys(value, expected, scope, gaps) {
  const actual = plainOwnDataKeys(value, scope, gaps);
  if (actual === null) return false;
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) pushGap(gaps, `${scope}_field_missing:${key}`);
  }
  for (const key of actual) {
    if (!expected.includes(key)) pushGap(gaps, `${scope}_field_unexpected:${key}`);
  }
  return actual.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (!isObject(value)) throw new TypeError('non_json_value');
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function hashMaterial(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function materialWithoutId(record, idField) {
  const material = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== idField) material[key] = value;
  }
  return material;
}

function recordMaterial(record) {
  return materialWithoutId(record, 'recordId');
}

function primitiveStringMatches(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function canonicalNs(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > GPU_HMR_TEST_TIMING_V3_MAX_NS_DIGITS
    || !NS_PATTERN.test(value)
  ) {
    return null;
  }
  const parsed = BigInt(value);
  return parsed <= MAX_NS ? parsed : null;
}

function clockReading(value) {
  if (typeof value === 'bigint' && value >= 0n && value <= MAX_NS) return value;
  if (
    typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && !Object.is(value, -0)
  ) {
    return BigInt(value);
  }
  const parsed = canonicalNs(value);
  if (parsed !== null) return parsed;
  throw new GpuHmrTestTimingV3Error('timing_v3_clock_value_invalid');
}

function stableId(value) {
  return primitiveStringMatches(value, STABLE_ID_PATTERN);
}

function stableReason(value) {
  return primitiveStringMatches(value, REASON_PATTERN);
}

function sortedUniqueStrings(values) {
  return [...new Set(values)].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function plainOwnDataArrayValues(value, scope, gaps) {
  let prototype;
  let lengthDescriptor;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    pushGap(gaps, `${scope}_evidence_refs_material_invalid`);
    return null;
  }
  if (prototype !== Array.prototype) {
    pushGap(gaps, `${scope}_evidence_refs_prototype_invalid`);
    return null;
  }
  let ownKeys;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    ownKeys = Reflect.ownKeys(value);
  } catch {
    pushGap(gaps, `${scope}_evidence_refs_material_invalid`);
    return null;
  }
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) {
    pushGap(gaps, `${scope}_evidence_refs_length_invalid`);
    return null;
  }
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    pushGap(gaps, `${scope}_evidence_refs_symbol_property_rejected`);
    return null;
  }
  const expectedKeys = new Set(['length']);
  const values = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const key = String(index);
    expectedKeys.add(key);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      pushGap(gaps, `${scope}_evidence_refs_material_invalid`);
      return null;
    }
    if (!descriptor) {
      pushGap(gaps, `${scope}_evidence_refs_hole_rejected`);
      return null;
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      pushGap(gaps, `${scope}_evidence_refs_accessor_property_rejected`);
      return null;
    }
    if (!descriptor.enumerable) {
      pushGap(gaps, `${scope}_evidence_refs_non_enumerable_property_rejected`);
      return null;
    }
    values.push(descriptor.value);
  }
  if (ownKeys.some((key) => !expectedKeys.has(key))) {
    pushGap(gaps, `${scope}_evidence_refs_property_unexpected`);
    return null;
  }
  return values;
}

function validateEvidenceRefs(value, scope, gaps, { requireNonEmpty = true } = {}) {
  if (!Array.isArray(value)) {
    pushGap(gaps, `${scope}_evidence_refs_not_array`);
    return [];
  }
  let lengthDescriptor;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    pushGap(gaps, `${scope}_evidence_refs_material_invalid`);
    return [];
  }
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')) {
    pushGap(gaps, `${scope}_evidence_refs_length_invalid`);
    return [];
  }
  if (lengthDescriptor.value > GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS) {
    pushGap(gaps, `${scope}_evidence_refs_limit_exceeded`);
    return [];
  }
  const values = plainOwnDataArrayValues(value, scope, gaps);
  if (values === null) return [];
  if (requireNonEmpty && values.length === 0) {
    pushGap(gaps, `${scope}_evidence_refs_empty`);
  }
  for (const ref of values) {
    if (!stableId(ref)) pushGap(gaps, `${scope}_evidence_ref_invalid`);
  }
  const canonical = sortedUniqueStrings(values.filter((ref) => typeof ref === 'string'));
  if (canonical.length !== values.length || canonical.some((ref, index) => ref !== values[index])) {
    pushGap(gaps, `${scope}_evidence_refs_not_canonical`);
  }
  return canonical;
}

function validateBinding(binding, scope, gaps) {
  if (!exactKeys(binding, BINDING_KEYS, scope, gaps)) return null;
  if (!RUN_MODE_SET.has(binding.runMode)) pushGap(gaps, `${scope}_run_mode_invalid`);
  if (!SPLIT_MODE_SET.has(binding.splitMode)) pushGap(gaps, `${scope}_split_mode_invalid`);
  if (!MODALITY_SET.has(binding.modality)) pushGap(gaps, `${scope}_modality_invalid`);
  if (!OUTCOME_SET.has(binding.outcome)) pushGap(gaps, `${scope}_outcome_invalid`);
  for (const field of ['sourceManifestHash', 'editHash', 'artifactHash']) {
    if (!primitiveStringMatches(binding[field], HASH_PATTERN)) {
      pushGap(gaps, `${scope}_${field}_invalid`);
    }
  }
  if (!stableId(binding.editId)) pushGap(gaps, `${scope}_edit_id_invalid`);
  for (const field of ['proofLedgerId', 'runtimeProofId']) {
    if (binding[field] !== null && !stableId(binding[field])) {
      pushGap(gaps, `${scope}_${field}_invalid`);
    }
  }
  for (const field of ['runtimeSessionId', 'processIdentity', 'clockDomainId']) {
    if (!stableId(binding[field])) pushGap(gaps, `${scope}_${field}_invalid`);
  }
  if (!primitiveStringMatches(binding.clockSourceManifestId, CLOCK_SOURCE_ID_PATTERN)) {
    pushGap(gaps, `${scope}_clock_source_manifest_id_invalid`);
  }
  if (!primitiveStringMatches(binding.clockSourceIdentityHash, HASH_PATTERN)) {
    pushGap(gaps, `${scope}_clock_source_identity_hash_invalid`);
  }
  return binding;
}

function clockSourceManifestId(manifest) {
  return `gpu-hmr-timing-clock-source:sha256:${hashMaterial(
    materialWithoutId(manifest, 'manifestId'),
  )}`;
}

function createClockSourceManifest(input, profile) {
  const gaps = [];
  if (!exactKeys(input, CLOCK_SOURCE_INPUT_KEYS, 'clock_source_input', gaps)) {
    throw new GpuHmrTestTimingV3Error('timing_v3_clock_source_input_invalid', { gaps });
  }
  for (const field of ['recorderImplementationHash', 'clockSourceIdentityHash']) {
    if (!primitiveStringMatches(input?.[field], HASH_PATTERN)) {
      pushGap(gaps, `clock_source_${field}_invalid`);
    }
  }
  for (const field of ['clockDomainId', 'runtimeSessionId', 'processIdentity']) {
    if (!stableId(input?.[field])) pushGap(gaps, `clock_source_${field}_invalid`);
  }
  const evidenceRefs = validateEvidenceRefs(input?.evidenceRefs, 'clock_source', gaps);
  if (gaps.length > 0) {
    throw new GpuHmrTestTimingV3Error('timing_v3_clock_source_input_invalid', { gaps });
  }
  const manifest = {
    schema: GPU_HMR_TEST_TIMING_V3_CLOCK_SOURCE_SCHEMA,
    schemaVersion: 1,
    manifestId: null,
    recorderImplementationHash: input.recorderImplementationHash,
    clockKind: GPU_HMR_TEST_TIMING_V3_CLOCK,
    unit: GPU_HMR_TEST_TIMING_V3_UNIT,
    clockDomainId: input.clockDomainId,
    clockSourceIdentityHash: input.clockSourceIdentityHash,
    clockImplementation: profile.clockImplementation,
    testOnly: profile.testOnly,
    persistenceEligible: profile.persistenceEligible,
    runtimeSessionId: input.runtimeSessionId,
    processIdentity: input.processIdentity,
    evidenceRefs,
    authority: 'clock_source_provenance_only_not_gpu_hmr_acceptance',
    timingOnly: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
  };
  manifest.manifestId = clockSourceManifestId(manifest);
  return deepFreeze(manifest);
}

export function createGpuHmrTestTimingV3ClockSourceManifest(input) {
  return createClockSourceManifest(input, {
    clockImplementation: CLOCK_IMPLEMENTATION_HRTIME,
    testOnly: false,
    persistenceEligible: true,
  });
}

function registerClockCapability(now, manifest) {
  const capability = Object.freeze(Object.create(null));
  CLOCK_CAPABILITY_DATA.set(capability, {
    now,
    manifest,
    lastNs: null,
  });
  return capability;
}

export function createGpuHmrTestTimingV3ClockCapability(input) {
  const manifest = createGpuHmrTestTimingV3ClockSourceManifest(input);
  return registerClockCapability(INTRINSIC_PROCESS_HRTIME_BIGINT, manifest);
}

export function createGpuHmrTestTimingV3TestClockCapability(input) {
  const gaps = [];
  if (!exactKeys(input, TEST_CLOCK_CAPABILITY_INPUT_KEYS, 'test_clock_capability_input', gaps)) {
    throw new GpuHmrTestTimingV3Error('timing_v3_test_clock_capability_invalid', { gaps });
  }
  if (typeof input?.now !== 'function') pushGap(gaps, 'test_clock_now_invalid');
  let manifest = null;
  try {
    manifest = createClockSourceManifest(input?.manifestInput, {
      clockImplementation: CLOCK_IMPLEMENTATION_SYNTHETIC,
      testOnly: true,
      persistenceEligible: false,
    });
  } catch (error) {
    pushGap(gaps, 'test_clock_manifest_input_invalid');
    if (error?.details?.gaps) {
      for (const gap of error.details.gaps) pushGap(gaps, `test_clock_manifest:${gap}`);
    }
  }
  if (gaps.length > 0) {
    throw new GpuHmrTestTimingV3Error('timing_v3_test_clock_capability_invalid', { gaps });
  }
  return registerClockCapability(input.now, manifest);
}

function requireClockCapability(capability, code = 'timing_v3_clock_capability_invalid') {
  const data = (
    capability !== null
    && (typeof capability === 'object' || typeof capability === 'function')
  ) ? CLOCK_CAPABILITY_DATA.get(capability) : null;
  if (!data) throw new GpuHmrTestTimingV3Error(code);
  return data;
}

function readClockCapabilityNs(capability) {
  const data = requireClockCapability(capability);
  const value = clockReading(data.now());
  if (data.lastNs !== null && value < data.lastNs) {
    throw new GpuHmrTestTimingV3Error('timing_v3_clock_regressed');
  }
  data.lastNs = value;
  return value;
}

export function getGpuHmrTestTimingV3ClockSourceManifest(capability) {
  return requireClockCapability(capability).manifest;
}

function clockManifestIsPersistenceEligible(manifest) {
  return manifest?.clockImplementation === CLOCK_IMPLEMENTATION_HRTIME
    && manifest?.testOnly === false
    && manifest?.persistenceEligible === true;
}

export function validateGpuHmrTestTimingV3ClockSourceManifest(manifest) {
  const gaps = [];
  if (!assessBoundedMaterialAndAuthority(manifest, gaps)) {
    return deepFreeze({ valid: false, gaps, recomputedManifestId: null });
  }
  exactKeys(manifest, CLOCK_SOURCE_MANIFEST_KEYS, 'clock_source_manifest', gaps);
  if (manifest?.schema !== GPU_HMR_TEST_TIMING_V3_CLOCK_SOURCE_SCHEMA) {
    pushGap(gaps, 'clock_source_schema_invalid');
  }
  if (manifest?.schemaVersion !== 1) pushGap(gaps, 'clock_source_schema_version_invalid');
  if (manifest?.clockKind !== GPU_HMR_TEST_TIMING_V3_CLOCK) {
    pushGap(gaps, 'clock_source_clock_kind_invalid');
  }
  if (manifest?.unit !== GPU_HMR_TEST_TIMING_V3_UNIT) pushGap(gaps, 'clock_source_unit_invalid');
  for (const field of ['recorderImplementationHash', 'clockSourceIdentityHash']) {
    if (!primitiveStringMatches(manifest?.[field], HASH_PATTERN)) {
      pushGap(gaps, `clock_source_${field}_invalid`);
    }
  }
  for (const field of ['clockDomainId', 'runtimeSessionId', 'processIdentity']) {
    if (!stableId(manifest?.[field])) pushGap(gaps, `clock_source_${field}_invalid`);
  }
  validateEvidenceRefs(manifest?.evidenceRefs, 'clock_source_manifest', gaps);
  if (manifest?.clockImplementation === CLOCK_IMPLEMENTATION_HRTIME) {
    if (manifest?.testOnly !== false) pushGap(gaps, 'clock_source_test_only_invalid');
    if (manifest?.persistenceEligible !== true) {
      pushGap(gaps, 'clock_source_persistence_eligibility_invalid');
    }
  } else if (manifest?.clockImplementation === CLOCK_IMPLEMENTATION_SYNTHETIC) {
    if (manifest?.testOnly !== true) pushGap(gaps, 'clock_source_test_only_invalid');
    if (manifest?.persistenceEligible !== false) {
      pushGap(gaps, 'clock_source_persistence_eligibility_invalid');
    }
  } else {
    pushGap(gaps, 'clock_source_implementation_invalid');
  }
  if (manifest?.authority !== 'clock_source_provenance_only_not_gpu_hmr_acceptance') {
    pushGap(gaps, 'clock_source_authority_invalid');
  }
  if (manifest?.timingOnly !== true) pushGap(gaps, 'clock_source_timing_only_invalid');
  if (manifest?.acceptedForGpuHmr !== false) pushGap(gaps, 'clock_source_acceptance_claim');
  if (manifest?.gpuHmrSuccess !== false) pushGap(gaps, 'clock_source_success_claim');
  let recomputedManifestId = null;
  try {
    recomputedManifestId = clockSourceManifestId(manifest);
    if (!primitiveStringMatches(manifest?.manifestId, CLOCK_SOURCE_ID_PATTERN)) {
      pushGap(gaps, 'clock_source_manifest_id_format_invalid');
    }
    if (manifest?.manifestId !== recomputedManifestId) {
      pushGap(gaps, 'clock_source_manifest_id_mismatch');
    }
  } catch {
    pushGap(gaps, 'clock_source_manifest_material_invalid');
  }
  return deepFreeze({ valid: gaps.length === 0, gaps, recomputedManifestId });
}

function assessBoundedMaterialAndAuthority(value, gaps) {
  const pending = [{ value, path: 'record', depth: 0, ancestors: [] }];
  let nodeCount = 0;
  let byteLength = 0;
  const addBytes = (amount) => {
    byteLength += amount;
    if (byteLength > GPU_HMR_TEST_TIMING_V3_MAX_RECORD_BYTES) {
      pushGap(gaps, 'record_byte_limit_exceeded');
      return false;
    }
    return true;
  };
  while (pending.length > 0) {
    const current = pending.pop();
    nodeCount += 1;
    if (nodeCount > 100_000) {
      pushGap(gaps, 'record_node_limit_exceeded');
      return false;
    }
    if (current.depth > 12) {
      pushGap(gaps, 'record_depth_limit_exceeded');
      return false;
    }
    if (current.value === null) {
      if (!addBytes(4)) return false;
      continue;
    }
    if (typeof current.value === 'string') {
      if (current.value.length > 2_048) {
        pushGap(gaps, `record_string_limit_exceeded:${current.path}`);
        return false;
      }
      if (!addBytes(Buffer.byteLength(JSON.stringify(current.value), 'utf8'))) return false;
      continue;
    }
    if (typeof current.value === 'boolean') {
      if (!addBytes(current.value ? 4 : 5)) return false;
      continue;
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) {
        pushGap(gaps, `record_json_material_invalid:${current.path}`);
        return false;
      }
      if (!addBytes(Buffer.byteLength(JSON.stringify(current.value), 'utf8'))) return false;
      continue;
    }
    if (typeof current.value !== 'object') {
      pushGap(gaps, `record_json_material_invalid:${current.path}`);
      return false;
    }
    if (current.ancestors.includes(current.value)) {
      pushGap(gaps, `record_cycle_rejected:${current.path}`);
      return false;
    }
    const ancestors = [...current.ancestors, current.value];
    if (Array.isArray(current.value)) {
      let prototype;
      let lengthDescriptor;
      try {
        prototype = Object.getPrototypeOf(current.value);
        lengthDescriptor = Object.getOwnPropertyDescriptor(current.value, 'length');
      } catch {
        pushGap(gaps, `record_json_material_invalid:${current.path}`);
        return false;
      }
      if (prototype !== Array.prototype) {
        pushGap(gaps, `record_array_prototype_invalid:${current.path}`);
        return false;
      }
      if (
        !lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
      ) {
        pushGap(gaps, `record_array_length_invalid:${current.path}`);
        return false;
      }
      const length = lengthDescriptor.value;
      const semanticLimit = current.path.endsWith('.phases')
        ? GPU_HMR_TEST_TIMING_V3_PHASES.length
        : current.path.endsWith('.attempts')
          ? GPU_HMR_TEST_TIMING_V3_MAX_ATTEMPTS_PER_PHASE
          : current.path.endsWith('.evidenceRefs')
            ? GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS
            : 2_048;
      if (length > semanticLimit) {
        pushGap(gaps, `record_array_limit_exceeded:${current.path}`);
        return false;
      }
      let ownKeys;
      try {
        ownKeys = Reflect.ownKeys(current.value);
      } catch {
        pushGap(gaps, `record_json_material_invalid:${current.path}`);
        return false;
      }
      if (ownKeys.some((key) => typeof key === 'symbol')) {
        pushGap(gaps, `record_symbol_property_rejected:${current.path}`);
        return false;
      }
      const expectedKeys = new Set(['length']);
      if (!addBytes(2 + Math.max(0, length - 1))) return false;
      for (let index = length - 1; index >= 0; index -= 1) {
        const key = String(index);
        expectedKeys.add(key);
        let descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        } catch {
          pushGap(gaps, `record_json_material_invalid:${current.path}[${index}]`);
          return false;
        }
        if (!descriptor) {
          pushGap(gaps, `record_array_hole_rejected:${current.path}[${index}]`);
          return false;
        }
        if (!Object.hasOwn(descriptor, 'value')) {
          pushGap(gaps, `record_accessor_property_rejected:${current.path}[${index}]`);
          return false;
        }
        if (!descriptor.enumerable) {
          pushGap(gaps, `record_non_enumerable_property_rejected:${current.path}[${index}]`);
          return false;
        }
        pending.push({
          value: descriptor.value,
          path: `${current.path}[${index}]`,
          depth: current.depth + 1,
          ancestors,
        });
      }
      if (ownKeys.some((key) => !expectedKeys.has(key))) {
        pushGap(gaps, `record_array_property_unexpected:${current.path}`);
        return false;
      }
      continue;
    }
    let prototype;
    try {
      prototype = Object.getPrototypeOf(current.value);
    } catch {
      pushGap(gaps, `record_json_material_invalid:${current.path}`);
      return false;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      pushGap(gaps, `record_object_prototype_invalid:${current.path}`);
      return false;
    }
    let ownKeys;
    try {
      ownKeys = Reflect.ownKeys(current.value);
    } catch {
      pushGap(gaps, `record_json_material_invalid:${current.path}`);
      return false;
    }
    if (ownKeys.length > 64) {
      pushGap(gaps, `record_object_field_limit_exceeded:${current.path}`);
      return false;
    }
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      pushGap(gaps, `record_symbol_property_rejected:${current.path}`);
      return false;
    }
    if (!addBytes(2 + Math.max(0, ownKeys.length - 1))) return false;
    for (const key of ownKeys) {
      if (key.length > 2_048) {
        pushGap(gaps, `record_key_limit_exceeded:${current.path}`);
        return false;
      }
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      } catch {
        pushGap(gaps, `record_json_material_invalid:${current.path}.${key}`);
        return false;
      }
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        pushGap(gaps, `record_accessor_property_rejected:${current.path}.${key}`);
        return false;
      }
      if (!descriptor.enumerable) {
        pushGap(gaps, `record_non_enumerable_property_rejected:${current.path}.${key}`);
        return false;
      }
      const child = descriptor.value;
      if (!addBytes(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)) return false;
      const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      if (SUCCESS_CLAIM_KEYS.has(normalized) && child !== false) {
        pushGap(gaps, `authority_or_success_claim_rejected:${current.path}.${key}`);
      }
      if (AUTHORITY_CLAIM_KEYS.has(normalized)) {
        pushGap(gaps, `authority_or_success_claim_rejected:${current.path}.${key}`);
      }
      pending.push({
        value: child,
        path: `${current.path}.${key}`,
        depth: current.depth + 1,
        ancestors,
      });
    }
  }
  return true;
}

function phaseBounds(parsedPhase) {
  if (!parsedPhase || parsedPhase.disposition !== 'measured' || parsedPhase.attempts.length === 0) {
    return null;
  }
  return {
    startNs: parsedPhase.attempts[0].startNs,
    endNs: parsedPhase.attempts[parsedPhase.attempts.length - 1].endNs,
  };
}

function firstCompletedAttempt(parsedPhase) {
  return parsedPhase?.attempts.find((attempt) => attempt.result === 'completed') ?? null;
}

function dispatchToOutputEvidenceRefs(dispatchAttempt, oracleAttempt) {
  return sortedUniqueStrings([
    ...dispatchAttempt.evidenceRefs,
    ...oracleAttempt.evidenceRefs,
  ]);
}

function parseAttempt(attempt, phaseKey, index, domainId, gaps) {
  const scope = `phase:${phaseKey}:attempt:${index + 1}`;
  if (!exactKeys(attempt, ATTEMPT_KEYS, scope, gaps)) return null;
  if (attempt.attempt !== index + 1) pushGap(gaps, `${scope}_ordinal_invalid`);
  if (!ATTEMPT_RESULT_SET.has(attempt.result)) pushGap(gaps, `${scope}_result_invalid`);
  if (!MEASUREMENT_KIND_SET.has(attempt.measurementKind)) {
    pushGap(gaps, `${scope}_measurement_kind_invalid`);
  }
  const startNs = canonicalNs(attempt.startNs);
  const endNs = canonicalNs(attempt.endNs);
  const durationNs = canonicalNs(attempt.durationNs);
  if (startNs === null) pushGap(gaps, `${scope}_start_ns_invalid`);
  if (endNs === null) pushGap(gaps, `${scope}_end_ns_invalid`);
  if (durationNs === null) pushGap(gaps, `${scope}_duration_ns_invalid`);
  if (startNs !== null && endNs !== null && endNs < startNs) {
    pushGap(gaps, `${scope}_end_before_start`);
  }
  if (startNs !== null && endNs !== null && endNs === startNs) {
    pushGap(gaps, `${scope}_zero_duration_rejected`);
  }
  if (
    startNs !== null
    && endNs !== null
    && durationNs !== null
    && endNs >= startNs
    && durationNs !== endNs - startNs
  ) {
    pushGap(gaps, `${scope}_duration_mismatch`);
  }
  const clockDomainMatches = domainId !== null && attempt.clockDomainId === domainId;
  if (!clockDomainMatches) pushGap(gaps, `${scope}_clock_domain_mismatch`);
  if (!stableId(attempt.source)) pushGap(gaps, `${scope}_source_invalid`);
  validateEvidenceRefs(attempt.evidenceRefs, scope, gaps);
  if (startNs === null || endNs === null || durationNs === null || !clockDomainMatches) {
    return null;
  }
  return {
    attempt: attempt.attempt,
    result: attempt.result,
    measurementKind: attempt.measurementKind,
    startNs,
    endNs,
    durationNs,
    clockDomainId: attempt.clockDomainId,
    source: attempt.source,
    evidenceRefs: attempt.evidenceRefs,
  };
}

function parsePhase(phase, expectedPhase, domainId, outcome, gaps) {
  const scope = `phase:${expectedPhase}`;
  if (!exactKeys(phase, PHASE_KEYS, scope, gaps)) return null;
  if (phase.phase !== expectedPhase) pushGap(gaps, `${scope}_order_or_name_invalid`);
  if (!DISPOSITION_SET.has(phase.disposition)) pushGap(gaps, `${scope}_disposition_invalid`);
  validateEvidenceRefs(phase.evidenceRefs, scope, gaps);
  if (!Array.isArray(phase.attempts)) {
    pushGap(gaps, `${scope}_attempts_not_array`);
    return null;
  }
  if (phase.attempts.length > GPU_HMR_TEST_TIMING_V3_MAX_ATTEMPTS_PER_PHASE) {
    pushGap(gaps, `${scope}_attempt_limit_exceeded`);
    return null;
  }

  const attempts = phase.attempts
    .map((attempt, index) => parseAttempt(attempt, expectedPhase, index, domainId, gaps))
    .filter(Boolean);
  if (phase.disposition === 'measured') {
    if (!MEASUREMENT_KIND_SET.has(phase.measurementKind)) {
      pushGap(gaps, `${scope}_measurement_kind_invalid`);
    }
    if (phase.reasonCode !== null) pushGap(gaps, `${scope}_measured_reason_must_be_null`);
    if (phase.attempts.length === 0) pushGap(gaps, `${scope}_measured_attempts_empty`);
    const completedAttempts = attempts.filter((attempt) => attempt.result === 'completed');
    if (completedAttempts.length > 1 || (outcome === 'completed' && completedAttempts.length !== 1)) {
      pushGap(gaps, `${scope}_exactly_one_completed_attempt_required`);
    }
    if (completedAttempts.length === 1 && attempts.at(-1)?.result !== 'completed') {
      pushGap(gaps, `${scope}_completion_must_be_terminal`);
    }
    if (attempts.some((attempt) => attempt.measurementKind !== phase.measurementKind)) {
      pushGap(gaps, `${scope}_attempt_measurement_kind_mismatch`);
    }
    const expectedRefs = sortedUniqueStrings(attempts.flatMap((attempt) => attempt.evidenceRefs));
    if (expectedRefs.length > GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS) {
      pushGap(gaps, `${scope}_aggregate_evidence_refs_limit_exceeded`);
    }
    if (!arraysEqual(expectedRefs, phase.evidenceRefs)) {
      pushGap(gaps, `${scope}_evidence_refs_not_derived_from_attempts`);
    }
  } else {
    if (phase.measurementKind !== 'none') {
      pushGap(gaps, `${scope}_reasoned_measurement_kind_must_be_none`);
    }
    if (!stableReason(phase.reasonCode)) pushGap(gaps, `${scope}_reason_code_invalid`);
    if (phase.attempts.length !== 0) pushGap(gaps, `${scope}_reasoned_attempts_must_be_empty`);
  }

  let completedSeen = false;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (index > 0 && attempts[index - 1].endNs > attempt.startNs) {
      pushGap(gaps, `${scope}_attempt_overlap`);
    }
    if (completedSeen && attempt.result === 'failed') {
      pushGap(gaps, `${scope}_failed_attempt_after_completion`);
    }
    if (attempt.result === 'completed') completedSeen = true;
  }

  return {
    phase: expectedPhase,
    disposition: phase.disposition,
    measurementKind: phase.measurementKind,
    attempts,
  };
}

function parsePhases(phases, domainId, outcome, gaps) {
  if (!Array.isArray(phases)) {
    pushGap(gaps, 'phases_not_array');
    return new Map();
  }
  if (phases.length > GPU_HMR_TEST_TIMING_V3_PHASES.length) {
    pushGap(gaps, 'phase_count_invalid');
    return new Map();
  }
  const counts = new Map();
  for (const phase of phases) {
    if (isObject(phase) && typeof phase.phase === 'string') {
      counts.set(phase.phase, (counts.get(phase.phase) ?? 0) + 1);
    }
  }
  for (const [phase, count] of counts) {
    if (count > 1) pushGap(gaps, `phase_duplicate:${phase}`);
    if (!PHASE_SET.has(phase)) pushGap(gaps, `phase_unknown:${phase}`);
  }
  if (phases.length !== GPU_HMR_TEST_TIMING_V3_PHASES.length) {
    pushGap(gaps, 'phase_count_invalid');
  }
  const parsed = new Map();
  for (let index = 0; index < GPU_HMR_TEST_TIMING_V3_PHASES.length; index += 1) {
    const expectedPhase = GPU_HMR_TEST_TIMING_V3_PHASES[index];
    const phase = phases[index];
    if (phase === undefined) {
      pushGap(gaps, `phase_missing:${expectedPhase}`);
      continue;
    }
    const parsedPhase = parsePhase(phase, expectedPhase, domainId, outcome, gaps);
    if (parsedPhase) parsed.set(expectedPhase, parsedPhase);
  }
  return parsed;
}

function validateCompletedPhaseBoundary(
  boundary,
  expectedKind,
  expectedPhase,
  parsed,
  domainId,
  scope,
  gaps,
) {
  const expectedAttempt = firstCompletedAttempt(parsed.get(expectedPhase));
  if (expectedAttempt === null) {
    if (boundary !== null) pushGap(gaps, `${scope}_without_completed_phase`);
    return null;
  }
  if (!exactKeys(boundary, BOUNDARY_KEYS, scope, gaps)) return null;
  if (boundary.kind !== expectedKind) pushGap(gaps, `${scope}_kind_invalid`);
  const timestamp = canonicalNs(boundary.monotonicNs);
  if (timestamp === null) pushGap(gaps, `${scope}_timestamp_invalid`);
  const clockDomainMatches = domainId !== null && boundary.clockDomainId === domainId;
  if (!clockDomainMatches) {
    pushGap(gaps, `${scope}_clock_domain_mismatch`);
  }
  if (!stableId(boundary.source)) pushGap(gaps, `${scope}_source_invalid`);
  validateEvidenceRefs(boundary.evidenceRefs, scope, gaps);
  if (timestamp !== null && timestamp !== expectedAttempt.endNs) {
    pushGap(gaps, `${scope}_not_first_completed_phase`);
  }
  if (boundary.source !== expectedAttempt.source) {
    pushGap(gaps, `${scope}_source_mismatch`);
  }
  if (!arraysEqual(boundary.evidenceRefs, expectedAttempt.evidenceRefs)) {
    pushGap(gaps, `${scope}_evidence_mismatch`);
  }
  return clockDomainMatches ? timestamp : null;
}

function validatePresentationBoundary(boundary, parsed, domainId, outcome, gaps) {
  const scope = 'first_visible_boundary';
  const outputAttempt = firstCompletedAttempt(parsed.get('output_ready'));
  const firstCaptureAttempt = parsed.get('visual_capture')?.attempts[0] ?? null;
  const totalBounds = phaseBounds(parsed.get('total_validator_wall'));
  if (boundary === null) {
    if (outcome === 'completed') pushGap(gaps, `${scope}_required`);
    return null;
  }
  if (!exactKeys(boundary, BOUNDARY_KEYS, scope, gaps)) return null;
  if (boundary.kind !== 'post_dispatch_presentation_complete') {
    pushGap(gaps, `${scope}_kind_invalid`);
  }
  const timestamp = canonicalNs(boundary.monotonicNs);
  if (timestamp === null) pushGap(gaps, `${scope}_timestamp_invalid`);
  const clockDomainMatches = domainId !== null && boundary.clockDomainId === domainId;
  if (!clockDomainMatches) pushGap(gaps, `${scope}_clock_domain_mismatch`);
  if (!stableId(boundary.source)) pushGap(gaps, `${scope}_source_invalid`);
  validateEvidenceRefs(boundary.evidenceRefs, scope, gaps);
  if (!outputAttempt) {
    pushGap(gaps, `${scope}_without_completed_output_ready`);
  } else if (timestamp !== null && timestamp < outputAttempt.endNs) {
    pushGap(gaps, `${scope}_before_output_ready`);
  }
  if (firstCaptureAttempt && timestamp !== null && timestamp > firstCaptureAttempt.startNs) {
    pushGap(gaps, `${scope}_after_capture_started`);
  }
  if (
    totalBounds
    && timestamp !== null
    && (timestamp < totalBounds.startNs || timestamp > totalBounds.endNs)
  ) {
    pushGap(gaps, `${scope}_outside_total_validator_wall`);
  }
  return clockDomainMatches ? timestamp : null;
}

function assessDerivedDispatchInterval(parsed, domainId, gaps) {
  const dispatchAttempt = firstCompletedAttempt(parsed.get('dispatch'));
  const oracleAttempt = firstCompletedAttempt(parsed.get('oracle_analysis'));
  const derivedPhase = parsed.get('dispatch_to_output_proof');
  if (!dispatchAttempt || !oracleAttempt || derivedPhase?.disposition !== 'measured') return;
  const derivedAttempt = derivedPhase.attempts[0];
  const expectedEvidenceRefs = dispatchToOutputEvidenceRefs(
    dispatchAttempt,
    oracleAttempt,
  );
  if (expectedEvidenceRefs.length > GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS) {
    pushGap(gaps, 'dispatch_to_output_proof_evidence_limit_exceeded');
  }
  if (derivedPhase.measurementKind !== 'derived') {
    pushGap(gaps, 'dispatch_to_output_proof_phase_not_derived');
  }
  if (
    derivedPhase.attempts.length !== 1
    || derivedAttempt?.measurementKind !== 'derived'
    || derivedAttempt?.result !== 'completed'
  ) {
    pushGap(gaps, 'dispatch_to_output_proof_single_derived_attempt_required');
    return;
  }
  if (derivedAttempt.clockDomainId !== domainId) {
    pushGap(gaps, 'dispatch_to_output_proof_clock_domain_mismatch');
  }
  if (derivedAttempt.startNs !== dispatchAttempt.endNs) {
    pushGap(gaps, 'dispatch_to_output_proof_start_not_derived_from_dispatch');
  }
  if (derivedAttempt.endNs !== oracleAttempt.endNs) {
    pushGap(gaps, 'dispatch_to_output_proof_end_not_derived_from_oracle');
  }
  if (derivedAttempt.source !== 'derived:dispatch_to_output_proof') {
    pushGap(gaps, 'dispatch_to_output_proof_source_invalid');
  }
  if (!arraysEqual(derivedAttempt.evidenceRefs, expectedEvidenceRefs)) {
    pushGap(gaps, 'dispatch_to_output_proof_evidence_not_derived');
  }
}

function addCausalEdge(parsed, predecessorKey, successorKey, gaps) {
  const predecessor = phaseBounds(parsed.get(predecessorKey));
  const successor = phaseBounds(parsed.get(successorKey));
  if (predecessor && successor && predecessor.endNs > successor.startNs) {
    pushGap(gaps, `phase_causal_order_invalid:${predecessorKey}:${successorKey}`);
  }
}

function assessCausality(parsed, modality, gaps) {
  for (const [predecessor, successor] of [
    ['discovery', 'ai_split'],
    ['provider_availability', 'ai_split'],
    ['ai_split', 'compile'],
    ['compile', 'artifact_load'],
    ['artifact_load', 'epoch_publish'],
    ['epoch_publish', 'dispatch'],
    ['dispatch', 'output_ready'],
  ]) {
    addCausalEdge(parsed, predecessor, successor, gaps);
  }
  if (modality === 'visual') {
    addCausalEdge(parsed, 'output_ready', 'visual_capture', gaps);
    addCausalEdge(parsed, 'visual_capture', 'visual_analysis', gaps);
    addCausalEdge(parsed, 'visual_analysis', 'oracle_analysis', gaps);
  } else {
    addCausalEdge(parsed, 'output_ready', 'oracle_analysis', gaps);
  }
  addCausalEdge(parsed, 'dispatch', 'retirement', gaps);

  for (const predecessor of ['oracle_analysis', 'retirement', 'dispatch_to_output_proof']) {
    addCausalEdge(parsed, predecessor, 'proof_finalization', gaps);
  }
  addCausalEdge(parsed, 'proof_finalization', 'cleanup', gaps);

  const total = phaseBounds(parsed.get('total_validator_wall'));
  if (total) {
    for (const phaseKey of GPU_HMR_TEST_TIMING_V3_PHASES) {
      if (phaseKey === 'total_validator_wall') continue;
      const bounds = phaseBounds(parsed.get(phaseKey));
      if (bounds && (bounds.startNs < total.startNs || bounds.endNs > total.endNs)) {
        pushGap(gaps, `phase_outside_total_validator_wall:${phaseKey}`);
      }
    }
    for (const terminal of ['cleanup']) {
      const bounds = phaseBounds(parsed.get(terminal));
      if (bounds && total.endNs < bounds.endNs) {
        pushGap(gaps, `total_validator_wall_ends_before:${terminal}`);
      }
    }
  }
}

function assessPlaceholders(parsed, diagnostics) {
  const attempts = [];
  for (const phaseKey of GPU_HMR_TEST_TIMING_V3_PHASES) {
    if (phaseKey === 'total_validator_wall') continue;
    attempts.push(...(parsed.get(phaseKey)?.attempts ?? []));
  }
  if (attempts.length === 0) return;
  const boundaries = attempts.flatMap((attempt) => [attempt.startNs, attempt.endNs]);
  if (boundaries.every((value) => value === 0n)) {
    pushGap(diagnostics, 'all_zero_timing_placeholder_detected');
  }
  const unique = [...new Set(boundaries.map((value) => value.toString()))]
    .map((value) => BigInt(value))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (
    unique.length >= 8
    && unique.slice(1).every((value, index) => value - unique[index] === 1n)
  ) {
    pushGap(diagnostics, 'sequential_timing_placeholder_detected');
  }
}

function deriveSummaryFromParsed(parsed, firstVisibleNs, firstOutputReadyNs) {
  const phaseDurationNs = {};
  const phaseAttemptCount = {};
  const phaseFailedAttemptCount = {};
  for (const phaseKey of GPU_HMR_TEST_TIMING_V3_PHASES) {
    const phase = parsed.get(phaseKey);
    const attempts = phase?.disposition === 'measured' ? phase.attempts : [];
    phaseDurationNs[phaseKey] = phase?.disposition === 'measured'
      ? attempts.reduce((sum, attempt) => sum + attempt.durationNs, 0n).toString()
      : null;
    phaseAttemptCount[phaseKey] = attempts.length;
    phaseFailedAttemptCount[phaseKey] = attempts.filter(
      (attempt) => attempt.result === 'failed',
    ).length;
  }
  const total = phaseBounds(parsed.get('total_validator_wall'));
  const dispatchProof = phaseBounds(parsed.get('dispatch_to_output_proof'));
  return {
    phaseDurationNs,
    phaseAttemptCount,
    phaseFailedAttemptCount,
    firstVisibleNs: firstVisibleNs?.toString() ?? null,
    timeToFirstVisibleNs: firstVisibleNs !== null && total
      ? (firstVisibleNs - total.startNs).toString()
      : null,
    firstOutputReadyNs: firstOutputReadyNs?.toString() ?? null,
    timeToFirstOutputReadyNs: firstOutputReadyNs !== null && total
      ? (firstOutputReadyNs - total.startNs).toString()
      : null,
    dispatchToOutputProofNs: dispatchProof
      ? (dispatchProof.endNs - dispatchProof.startNs).toString()
      : null,
    totalValidatorWallNs: total
      ? (total.endNs - total.startNs).toString()
      : null,
  };
}

function validateSummary(summary, recomputed, gaps) {
  if (!exactKeys(summary, SUMMARY_KEYS, 'summary', gaps)) return;
  for (const field of [
    'phaseDurationNs',
    'phaseAttemptCount',
    'phaseFailedAttemptCount',
  ]) {
    if (!exactKeys(
      summary[field],
      GPU_HMR_TEST_TIMING_V3_PHASES,
      `summary:${field}`,
      gaps,
    )) continue;
    if (field === 'phaseAttemptCount' || field === 'phaseFailedAttemptCount') {
      for (const phaseKey of GPU_HMR_TEST_TIMING_V3_PHASES) {
        if (Object.is(summary[field][phaseKey], -0)) {
          pushGap(gaps, `summary:${field}_negative_zero:${phaseKey}`);
        }
      }
    }
  }
  try {
    if (canonicalJson(summary) !== canonicalJson(recomputed)) {
      pushGap(gaps, 'summary_not_derived_from_verified_spans');
    }
  } catch {
    pushGap(gaps, 'summary_json_material_invalid');
  }
}

function canonicalPhaseFromState(phaseKey, state) {
  if (state.disposition === 'measured') {
    const attempts = state.attempts.map((attempt) => ({ ...attempt }));
    return {
      phase: phaseKey,
      disposition: 'measured',
      measurementKind: state.measurementKind,
      reasonCode: null,
      evidenceRefs: sortedUniqueStrings(attempts.flatMap((attempt) => attempt.evidenceRefs)),
      attempts,
    };
  }
  return {
    phase: phaseKey,
    disposition: state.disposition,
    measurementKind: 'none',
    reasonCode: state.reasonCode,
    evidenceRefs: [...state.evidenceRefs],
    attempts: [],
  };
}

function evidenceRefsFromState(state) {
  if (state.disposition === 'measured') {
    return sortedUniqueStrings(state.attempts.flatMap((attempt) => attempt.evidenceRefs));
  }
  return [...(state.evidenceRefs ?? [])];
}

export class GpuHmrTestTimingV3Error extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'GpuHmrTestTimingV3Error';
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

export function recomputeGpuHmrTestTimingV3RecordId(record) {
  if (!isObject(record)) throw new GpuHmrTestTimingV3Error('timing_v3_record_not_object');
  const gaps = [];
  if (!assessBoundedMaterialAndAuthority(record, gaps)) {
    throw new GpuHmrTestTimingV3Error('timing_v3_record_material_limit_exceeded', { gaps });
  }
  return `gpu-hmr-test-timing-v3:sha256:${hashMaterial(recordMaterial(record))}`;
}

export function validateGpuHmrTestTimingV3(record, options = {}) {
  const gaps = [];
  const diagnostics = [];
  if (!assessBoundedMaterialAndAuthority(record, gaps)) {
    return deepFreeze({
      valid: false,
      gaps,
      diagnostics,
      recomputedRecordId: null,
      recomputedSummary: null,
    });
  }
  if (!exactKeys(options, VALIDATION_OPTION_KEYS, 'validation_options', gaps)) {
    return deepFreeze({
      valid: false,
      gaps,
      diagnostics,
      recomputedRecordId: null,
      recomputedSummary: null,
    });
  }
  if (!exactKeys(record, RECORD_KEYS, 'record', gaps)) {
    if (!isObject(record)) {
      return deepFreeze({
        valid: false,
        gaps,
        diagnostics,
        recomputedRecordId: null,
        recomputedSummary: null,
      });
    }
  }

  if (record.schema !== GPU_HMR_TEST_TIMING_V3_SCHEMA) pushGap(gaps, 'schema_invalid');
  if (record.schemaVersion !== GPU_HMR_TEST_TIMING_V3_SCHEMA_VERSION) {
    pushGap(gaps, 'schema_version_invalid');
  }
  if (record.authority !== GPU_HMR_TEST_TIMING_V3_AUTHORITY) {
    pushGap(gaps, 'authority_invalid');
  }
  if (record.timingOnly !== true) pushGap(gaps, 'timing_only_must_be_true');
  if (record.acceptedForGpuHmr !== false) pushGap(gaps, 'accepted_for_gpu_hmr_must_be_false');
  if (record.gpuHmrSuccess !== false) pushGap(gaps, 'gpu_hmr_success_must_be_false');
  if (!MODALITY_SET.has(record.modality)) pushGap(gaps, 'modality_invalid');
  if (!OUTCOME_SET.has(record.outcome)) pushGap(gaps, 'outcome_invalid');

  let domainId = null;
  if (exactKeys(record.clock, CLOCK_KEYS, 'clock', gaps)) {
    if (record.clock.kind !== GPU_HMR_TEST_TIMING_V3_CLOCK) pushGap(gaps, 'clock_kind_invalid');
    if (record.clock.unit !== GPU_HMR_TEST_TIMING_V3_UNIT) pushGap(gaps, 'clock_unit_invalid');
    if (!stableId(record.clock.domainId)) pushGap(gaps, 'clock_domain_id_invalid');
    else domainId = record.clock.domainId;
    if (!primitiveStringMatches(record.clock.sourceManifestId, CLOCK_SOURCE_ID_PATTERN)) {
      pushGap(gaps, 'clock_source_manifest_id_invalid');
    }
    if (!primitiveStringMatches(record.clock.sourceIdentityHash, HASH_PATTERN)) {
      pushGap(gaps, 'clock_source_identity_hash_invalid');
    }
  }

  const binding = validateBinding(record.binding, 'binding', gaps);
  const expectedBinding = validateBinding(options.expectedBinding, 'expected_binding', gaps);
  if (binding && expectedBinding) {
    for (const field of BINDING_KEYS) {
      if (binding[field] !== expectedBinding[field]) {
        pushGap(gaps, `binding_replay_mismatch:${field}`);
      }
    }
  }
  if (binding) {
    if (record.modality !== binding.modality) pushGap(gaps, 'record_binding_modality_mismatch');
    if (record.outcome !== binding.outcome) pushGap(gaps, 'record_binding_outcome_mismatch');
    if (record.clock?.domainId !== binding.clockDomainId) {
      pushGap(gaps, 'record_binding_clock_domain_mismatch');
    }
    if (record.clock?.sourceManifestId !== binding.clockSourceManifestId) {
      pushGap(gaps, 'record_binding_clock_source_manifest_mismatch');
    }
    if (record.clock?.sourceIdentityHash !== binding.clockSourceIdentityHash) {
      pushGap(gaps, 'record_binding_clock_source_identity_mismatch');
    }
  }

  const trustedClockValidation = validateGpuHmrTestTimingV3ClockSourceManifest(
    options.trustedClockSourceManifest,
  );
  if (!trustedClockValidation.valid) {
    pushGap(gaps, 'trusted_clock_source_manifest_invalid');
    for (const gap of trustedClockValidation.gaps) {
      pushGap(gaps, `trusted_clock_source:${gap}`);
    }
  } else if (binding) {
    const trusted = options.trustedClockSourceManifest;
    for (const [field, actual] of [
      ['clockSourceManifestId', trusted.manifestId],
      ['clockSourceIdentityHash', trusted.clockSourceIdentityHash],
      ['clockDomainId', trusted.clockDomainId],
      ['runtimeSessionId', trusted.runtimeSessionId],
      ['processIdentity', trusted.processIdentity],
    ]) {
      if (binding[field] !== actual) pushGap(gaps, `trusted_clock_binding_mismatch:${field}`);
    }
  }

  const parsed = parsePhases(record.phases, domainId, record.outcome, gaps);
  for (const terminal of TERMINAL_PHASE_SET) {
    const phase = parsed.get(terminal);
    if (phase?.disposition !== 'measured') pushGap(gaps, `terminal_phase_not_measured:${terminal}`);
    if (phase?.measurementKind !== 'observed') {
      pushGap(gaps, `terminal_phase_not_observed:${terminal}`);
    }
  }
  const total = parsed.get('total_validator_wall');
  if (total?.attempts.length !== 1 || total?.attempts[0]?.result !== 'completed') {
    pushGap(gaps, 'total_validator_wall_single_completed_attempt_required');
  }
  if (total?.measurementKind !== 'observed') {
    pushGap(gaps, 'total_validator_wall_must_be_observed');
  }

  const persistencePhase = Array.isArray(record.phases)
    ? record.phases.find((phase) => phase?.phase === 'durable_persistence')
    : null;
  if (
    persistencePhase?.disposition !== 'not_applicable'
    || persistencePhase?.measurementKind !== 'none'
    || persistencePhase?.reasonCode !== GPU_HMR_TEST_TIMING_V3_EXTERNAL_PERSISTENCE_REASON
  ) {
    pushGap(gaps, 'timing_record_must_not_claim_self_persistence');
  }
  if (
    binding
    && !arraysEqual(persistencePhase?.evidenceRefs, [binding.clockSourceManifestId])
  ) {
    pushGap(gaps, 'external_persistence_phase_evidence_mismatch');
  }
  const dispatchProofSource = Array.isArray(record.phases)
    ? record.phases.find((phase) => phase?.phase === 'dispatch_to_output_proof')
    : null;
  if (
    dispatchProofSource?.disposition !== 'measured'
    && (
      dispatchProofSource?.disposition !== 'unavailable'
      || dispatchProofSource?.measurementKind !== 'none'
      || dispatchProofSource?.reasonCode !== GPU_HMR_TEST_TIMING_V3_DERIVED_INTERVAL_REASON
    )
  ) {
    pushGap(gaps, 'dispatch_to_output_proof_unavailable_shape_invalid');
  }

  if (record.modality === 'compute') {
    for (const phaseKey of VISUAL_PHASE_SET) {
      const sourcePhase = Array.isArray(record.phases)
        ? record.phases.find((phase) => phase?.phase === phaseKey)
        : null;
      if (
        sourcePhase?.disposition !== 'not_applicable'
        || sourcePhase?.reasonCode !== GPU_HMR_TEST_TIMING_V3_COMPUTE_VISUAL_REASON
      ) {
        pushGap(gaps, `compute_visual_phase_not_typed_not_applicable:${phaseKey}`);
      }
    }
  }
  if (record.modality === 'visual' && record.outcome === 'completed') {
    for (const phaseKey of VISUAL_PHASE_SET) {
      if (parsed.get(phaseKey)?.disposition !== 'measured') {
        pushGap(gaps, `visual_phase_not_measured:${phaseKey}`);
      }
    }
  }
  if (record.outcome === 'completed') {
    for (const phaseKey of COMPLETED_CORE_PHASE_SET) {
      const requiredPhase = parsed.get(phaseKey);
      if (requiredPhase?.disposition !== 'measured') {
        pushGap(gaps, `completed_required_phase_not_measured:${phaseKey}`);
      } else if (
        phaseKey === 'dispatch_to_output_proof'
          ? requiredPhase.measurementKind !== 'derived'
          : requiredPhase.measurementKind !== 'observed'
      ) {
        pushGap(gaps, `completed_required_phase_measurement_kind_invalid:${phaseKey}`);
      }
    }
    if (binding?.runMode === 'cold' && binding.splitMode === 'fresh_ai') {
      for (const phaseKey of ['discovery', 'provider_availability', 'ai_split']) {
        const requiredPhase = parsed.get(phaseKey);
        if (
          requiredPhase?.disposition !== 'measured'
          || requiredPhase.measurementKind !== 'observed'
        ) {
          pushGap(gaps, `fresh_cold_ai_phase_not_measured:${phaseKey}`);
        }
      }
    }
  }

  let firstVisibleNs = null;
  let firstOutputReadyNs = null;
  if (record.modality === 'visual') {
    if (record.firstOutputReadyBoundary !== null) {
      pushGap(gaps, 'visual_record_must_not_carry_first_output_ready_boundary');
    }
    firstVisibleNs = validatePresentationBoundary(
      record.firstVisibleBoundary,
      parsed,
      domainId,
      record.outcome,
      gaps,
    );
  } else if (record.modality === 'compute') {
    if (record.firstVisibleBoundary !== null) {
      pushGap(gaps, 'compute_record_must_not_carry_first_visible_boundary');
    }
    firstOutputReadyNs = validateCompletedPhaseBoundary(
      record.firstOutputReadyBoundary,
      'post_dispatch_output_ready',
      'output_ready',
      parsed,
      domainId,
      'first_output_ready_boundary',
      gaps,
    );
  }
  assessDerivedDispatchInterval(parsed, domainId, gaps);
  assessCausality(parsed, record.modality, gaps);
  assessPlaceholders(parsed, diagnostics);

  const candidateSummary = deriveSummaryFromParsed(
    parsed,
    firstVisibleNs,
    firstOutputReadyNs,
  );
  validateSummary(record.summary, candidateSummary, gaps);

  let recomputedRecordId = null;
  try {
    recomputedRecordId = recomputeGpuHmrTestTimingV3RecordId(record);
    if (!primitiveStringMatches(record.recordId, RECORD_ID_PATTERN)) {
      pushGap(gaps, 'record_id_format_invalid');
    }
    if (record.recordId !== recomputedRecordId) pushGap(gaps, 'record_id_mismatch');
  } catch {
    pushGap(gaps, 'record_id_material_invalid');
  }

  const valid = gaps.length === 0;
  return deepFreeze({
    valid,
    gaps,
    diagnostics,
    recomputedRecordId,
    recomputedSummary: valid ? candidateSummary : null,
  });
}

export function assertValidGpuHmrTestTimingV3(record, options) {
  const validation = validateGpuHmrTestTimingV3(record, options);
  if (!validation.valid) {
    throw new GpuHmrTestTimingV3Error('timing_v3_record_invalid', {
      gaps: validation.gaps,
    });
  }
  return record;
}

export function deriveGpuHmrTestTimingV3Summary(record, options) {
  const validation = validateGpuHmrTestTimingV3(record, options);
  if (!validation.valid) {
    return deepFreeze({
      valid: false,
      summary: null,
      error: {
        code: 'timing_v3_record_invalid',
        gaps: validation.gaps,
        diagnostics: validation.diagnostics,
      },
    });
  }
  return deepFreeze({
    valid: true,
    summary: validation.recomputedSummary,
    error: null,
  });
}

export class GpuHmrTestTimingV3Recorder {
  #clockCapability;
  #clockDomainId;
  #clockSourceManifest;
  #binding;
  #modality;
  #outcome;
  #totalSource;
  #totalEvidenceRefs;
  #totalStartNs;
  #states;
  #activeTokens;
  #nextTokenId;
  #firstVisibleBoundary;
  #firstOutputReadyBoundary;
  #finalized;

  constructor(options) {
    const gaps = [];
    if (!exactKeys(options, RECORDER_OPTION_KEYS, 'recorder_options', gaps)) {
      throw new GpuHmrTestTimingV3Error('timing_v3_recorder_options_invalid', { gaps });
    }
    let capabilityData = null;
    try {
      capabilityData = requireClockCapability(options.clockCapability);
    } catch {
      pushGap(gaps, 'clock_capability_invalid');
    }
    validateBinding(options.binding, 'binding', gaps);
    const clockValidation = validateGpuHmrTestTimingV3ClockSourceManifest(
      capabilityData?.manifest,
    );
    if (!clockValidation.valid) {
      pushGap(gaps, 'trusted_clock_source_manifest_invalid');
    } else {
      const manifest = capabilityData.manifest;
      for (const [field, value] of [
        ['clockSourceManifestId', manifest.manifestId],
        ['clockSourceIdentityHash', manifest.clockSourceIdentityHash],
        ['clockDomainId', manifest.clockDomainId],
        ['runtimeSessionId', manifest.runtimeSessionId],
        ['processIdentity', manifest.processIdentity],
      ]) {
        if (options.binding?.[field] !== value) pushGap(gaps, `clock_binding_mismatch:${field}`);
      }
    }
    if (!stableId(options.totalSource)) pushGap(gaps, 'total_source_invalid');
    validateEvidenceRefs(options.totalEvidenceRefs, 'total', gaps);
    if (gaps.length > 0) {
      throw new GpuHmrTestTimingV3Error('timing_v3_recorder_options_invalid', { gaps });
    }
    this.#clockCapability = options.clockCapability;
    this.#clockSourceManifest = capabilityData.manifest;
    this.#clockDomainId = capabilityData.manifest.clockDomainId;
    this.#binding = structuredClone(options.binding);
    this.#modality = options.binding.modality;
    this.#outcome = options.binding.outcome;
    this.#totalSource = options.totalSource;
    this.#totalEvidenceRefs = [...options.totalEvidenceRefs];
    this.#states = new Map(
      GPU_HMR_TEST_TIMING_V3_PHASES
        .filter((phase) => phase !== 'total_validator_wall')
        .map((phase) => [phase, { disposition: 'untouched', attempts: [], active: false }]),
    );
    this.#states.set('durable_persistence', {
      disposition: 'not_applicable',
      reasonCode: GPU_HMR_TEST_TIMING_V3_EXTERNAL_PERSISTENCE_REASON,
      evidenceRefs: [this.#clockSourceManifest.manifestId],
      attempts: [],
      active: false,
    });
    this.#activeTokens = new Map();
    this.#nextTokenId = 1;
    this.#firstVisibleBoundary = null;
    this.#firstOutputReadyBoundary = null;
    this.#finalized = false;
    this.#totalStartNs = this.#readClock();
  }

  #readClock() {
    return readClockCapabilityNs(this.#clockCapability);
  }

  #validateDispatchProofEvidenceBudget(phase, candidateAttempt, gaps) {
    if (phase !== 'dispatch' && phase !== 'oracle_analysis') return;
    const candidateCompleted = candidateAttempt?.result === 'completed'
      ? candidateAttempt
      : null;
    const dispatchAttempt = phase === 'dispatch'
      ? candidateCompleted
      : this.#states.get('dispatch').attempts.find(
        (attempt) => attempt.result === 'completed',
      );
    const oracleAttempt = phase === 'oracle_analysis'
      ? candidateCompleted
      : this.#states.get('oracle_analysis').attempts.find(
        (attempt) => attempt.result === 'completed',
      );
    if (!dispatchAttempt || !oracleAttempt) return;
    const combinedEvidenceRefs = dispatchToOutputEvidenceRefs(
      dispatchAttempt,
      oracleAttempt,
    );
    if (combinedEvidenceRefs.length > GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS) {
      pushGap(gaps, 'dispatch_to_output_proof_evidence_limit_exceeded');
    }
  }

  #requireMutablePhase(phase) {
    if (this.#finalized) throw new GpuHmrTestTimingV3Error('timing_v3_recorder_finalized');
    if (
      !PHASE_SET.has(phase)
      || phase === 'total_validator_wall'
      || phase === 'dispatch_to_output_proof'
      || phase === 'durable_persistence'
    ) {
      throw new GpuHmrTestTimingV3Error('timing_v3_phase_invalid', { phase });
    }
    return this.#states.get(phase);
  }

  beginAttempt(phase, options) {
    const state = this.#requireMutablePhase(phase);
    const gaps = [];
    if (!exactKeys(options, ['source', 'evidenceRefs'], 'attempt_options', gaps)) {
      throw new GpuHmrTestTimingV3Error('timing_v3_attempt_begin_invalid', { gaps });
    }
    if (!stableId(options?.source)) pushGap(gaps, 'attempt_source_invalid');
    const beginEvidenceRefs = validateEvidenceRefs(options?.evidenceRefs, 'attempt', gaps);
    if (state.disposition !== 'untouched' && state.disposition !== 'measured') {
      pushGap(gaps, 'reasoned_phase_cannot_be_measured');
    }
    if (state.attempts.length >= GPU_HMR_TEST_TIMING_V3_MAX_ATTEMPTS_PER_PHASE) {
      pushGap(gaps, 'phase_attempt_limit_exceeded');
    }
    if (state.active) pushGap(gaps, 'phase_attempt_already_active');
    if (state.attempts.some((attempt) => attempt.result === 'completed')) {
      pushGap(gaps, 'phase_completion_is_terminal');
    }
    const aggregateEvidenceRefs = sortedUniqueStrings([
      ...state.attempts.flatMap((attempt) => attempt.evidenceRefs),
      ...beginEvidenceRefs,
    ]);
    if (aggregateEvidenceRefs.length > GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS) {
      pushGap(gaps, 'phase_aggregate_evidence_limit_exceeded');
    }
    if (gaps.length > 0) {
      throw new GpuHmrTestTimingV3Error('timing_v3_attempt_begin_invalid', { gaps });
    }
    const tokenId = this.#nextTokenId;
    this.#nextTokenId += 1;
    const token = {
      tokenId,
      phase,
      attempt: state.attempts.length + 1,
      startNs: this.#readClock(),
      source: options.source,
      evidenceRefs: beginEvidenceRefs,
    };
    state.disposition = 'measured';
    state.measurementKind = 'observed';
    state.active = true;
    this.#activeTokens.set(tokenId, token);
    return deepFreeze({ tokenId, phase, attempt: token.attempt });
  }

  finishAttempt(token, options) {
    if (this.#finalized) throw new GpuHmrTestTimingV3Error('timing_v3_recorder_finalized');
    const gaps = [];
    if (!exactKeys(options, ['result', 'evidenceRefs'], 'attempt_finish_options', gaps)) {
      throw new GpuHmrTestTimingV3Error('timing_v3_attempt_finish_invalid', { gaps });
    }
    if (!ATTEMPT_RESULT_SET.has(options?.result)) pushGap(gaps, 'attempt_result_invalid');
    const finishEvidenceRefs = validateEvidenceRefs(
      options?.evidenceRefs,
      'attempt_finish',
      gaps,
      { requireNonEmpty: false },
    );
    const active = isObject(token) ? this.#activeTokens.get(token.tokenId) : null;
    if (!active || token.phase !== active.phase || token.attempt !== active.attempt) {
      pushGap(gaps, 'attempt_token_invalid');
    }
    const state = active ? this.#states.get(active.phase) : null;
    const attemptEvidenceRefs = active ? sortedUniqueStrings([
      ...active.evidenceRefs,
      ...finishEvidenceRefs,
    ]) : [];
    const aggregateEvidenceRefs = state ? sortedUniqueStrings([
      ...state.attempts.flatMap((attempt) => attempt.evidenceRefs),
      ...attemptEvidenceRefs,
    ]) : [];
    if (aggregateEvidenceRefs.length > GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS) {
      pushGap(gaps, 'phase_aggregate_evidence_limit_exceeded');
    }
    if (active) {
      this.#validateDispatchProofEvidenceBudget(
        active.phase,
        {
          result: options.result,
          evidenceRefs: attemptEvidenceRefs,
        },
        gaps,
      );
    }
    if (gaps.length > 0) {
      throw new GpuHmrTestTimingV3Error('timing_v3_attempt_finish_invalid', { gaps });
    }
    const endNs = this.#readClock();
    if (endNs <= active.startNs) {
      throw new GpuHmrTestTimingV3Error('timing_v3_attempt_duration_not_positive');
    }
    const attempt = {
      attempt: active.attempt,
      result: options.result,
      measurementKind: 'observed',
      startNs: active.startNs.toString(),
      endNs: endNs.toString(),
      durationNs: (endNs - active.startNs).toString(),
      clockDomainId: this.#clockDomainId,
      source: active.source,
      evidenceRefs: attemptEvidenceRefs,
    };
    state.active = false;
    state.attempts.push(attempt);
    this.#activeTokens.delete(active.tokenId);
    if (
      this.#modality === 'compute'
      && active.phase === 'output_ready'
      && attempt.result === 'completed'
    ) {
      this.#firstOutputReadyBoundary = {
        kind: 'post_dispatch_output_ready',
        monotonicNs: attempt.endNs,
        clockDomainId: this.#clockDomainId,
        source: attempt.source,
        evidenceRefs: [...attempt.evidenceRefs],
      };
    }
    return deepFreeze(structuredClone(attempt));
  }

  markNotApplicable(phase, reasonCode, evidenceRefs) {
    this.#markReasoned(phase, 'not_applicable', reasonCode, evidenceRefs);
  }

  markUnavailable(phase, reasonCode, evidenceRefs) {
    this.#markReasoned(phase, 'unavailable', reasonCode, evidenceRefs);
  }

  #markReasoned(phase, disposition, reasonCode, evidenceRefs) {
    const state = this.#requireMutablePhase(phase);
    const gaps = [];
    if (state.disposition !== 'untouched' || state.active || state.attempts.length > 0) {
      pushGap(gaps, 'phase_already_observed');
    }
    if (!stableReason(reasonCode)) pushGap(gaps, 'reason_code_invalid');
    const canonicalEvidenceRefs = validateEvidenceRefs(
      evidenceRefs,
      'reasoned_phase',
      gaps,
    );
    if (gaps.length > 0) {
      throw new GpuHmrTestTimingV3Error('timing_v3_reasoned_phase_invalid', { gaps });
    }
    state.disposition = disposition;
    state.reasonCode = reasonCode;
    state.evidenceRefs = canonicalEvidenceRefs;
  }

  markPresentationComplete(options) {
    if (this.#finalized) throw new GpuHmrTestTimingV3Error('timing_v3_recorder_finalized');
    if (this.#firstVisibleBoundary !== null) {
      throw new GpuHmrTestTimingV3Error('timing_v3_first_visible_already_recorded');
    }
    if (this.#modality !== 'visual') {
      throw new GpuHmrTestTimingV3Error('timing_v3_first_visible_visual_only');
    }
    const gaps = [];
    if (!exactKeys(options, ['source', 'evidenceRefs'], 'first_visible_options', gaps)) {
      throw new GpuHmrTestTimingV3Error('timing_v3_first_visible_invalid', { gaps });
    }
    if (!stableId(options?.source)) pushGap(gaps, 'first_visible_source_invalid');
    const evidenceRefs = validateEvidenceRefs(options?.evidenceRefs, 'first_visible', gaps);
    const outputAttempt = this.#states.get('output_ready').attempts.find(
      (attempt) => attempt.result === 'completed',
    );
    if (!outputAttempt) pushGap(gaps, 'first_visible_requires_completed_output_ready');
    const captureState = this.#states.get('visual_capture');
    if (captureState.active || captureState.attempts.length > 0) {
      pushGap(gaps, 'first_visible_must_precede_visual_capture');
    }
    if (gaps.length > 0) {
      throw new GpuHmrTestTimingV3Error('timing_v3_first_visible_invalid', { gaps });
    }
    const monotonicNs = this.#readClock();
    this.#firstVisibleBoundary = {
      kind: 'post_dispatch_presentation_complete',
      monotonicNs: monotonicNs.toString(),
      clockDomainId: this.#clockDomainId,
      source: options.source,
      evidenceRefs,
    };
  }

  finalize() {
    if (this.#finalized) throw new GpuHmrTestTimingV3Error('timing_v3_recorder_finalized');
    const gaps = [];
    if (arguments.length !== 0) pushGap(gaps, 'finalize_options_forbidden');
    if (this.#activeTokens.size > 0) pushGap(gaps, 'active_attempts_remain');
    const dispatchAttempt = this.#states.get('dispatch').attempts.find(
      (attempt) => attempt.result === 'completed',
    );
    const oracleAttempt = this.#states.get('oracle_analysis').attempts.find(
      (attempt) => attempt.result === 'completed',
    );
    if (dispatchAttempt && oracleAttempt && BigInt(oracleAttempt.endNs) > BigInt(dispatchAttempt.endNs)) {
      const evidenceRefs = dispatchToOutputEvidenceRefs(dispatchAttempt, oracleAttempt);
      if (evidenceRefs.length > GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS) {
        pushGap(gaps, 'dispatch_to_output_proof_evidence_limit_exceeded');
      }
      this.#states.set('dispatch_to_output_proof', {
        disposition: 'measured',
        measurementKind: 'derived',
        attempts: [{
          attempt: 1,
          result: 'completed',
          measurementKind: 'derived',
          startNs: dispatchAttempt.endNs,
          endNs: oracleAttempt.endNs,
          durationNs: (
            BigInt(oracleAttempt.endNs) - BigInt(dispatchAttempt.endNs)
          ).toString(),
          clockDomainId: this.#clockDomainId,
          source: 'derived:dispatch_to_output_proof',
          evidenceRefs,
        }],
        active: false,
      });
    } else {
      const sourceRefs = sortedUniqueStrings([
        ...evidenceRefsFromState(this.#states.get('dispatch')),
        ...evidenceRefsFromState(this.#states.get('oracle_analysis')),
        this.#clockSourceManifest.manifestId,
      ]);
      if (sourceRefs.length > GPU_HMR_TEST_TIMING_V3_MAX_EVIDENCE_REFS) {
        pushGap(gaps, 'dispatch_to_output_proof_evidence_limit_exceeded');
      }
      this.#states.set('dispatch_to_output_proof', {
        disposition: 'unavailable',
        reasonCode: GPU_HMR_TEST_TIMING_V3_DERIVED_INTERVAL_REASON,
        evidenceRefs: sourceRefs,
        attempts: [],
        active: false,
      });
    }
    for (const [phase, state] of this.#states) {
      if (state.disposition === 'untouched') pushGap(gaps, `phase_not_disposed:${phase}`);
    }
    if (gaps.length > 0) {
      throw new GpuHmrTestTimingV3Error('timing_v3_finalize_invalid', { gaps });
    }

    const totalEndNs = this.#readClock();
    if (totalEndNs <= this.#totalStartNs) {
      throw new GpuHmrTestTimingV3Error('timing_v3_total_duration_not_positive');
    }
    const totalState = {
      disposition: 'measured',
      measurementKind: 'observed',
      attempts: [{
        attempt: 1,
        result: 'completed',
        measurementKind: 'observed',
        startNs: this.#totalStartNs.toString(),
        endNs: totalEndNs.toString(),
        durationNs: (totalEndNs - this.#totalStartNs).toString(),
        clockDomainId: this.#clockDomainId,
        source: this.#totalSource,
        evidenceRefs: [...this.#totalEvidenceRefs],
      }],
    };
    const phases = GPU_HMR_TEST_TIMING_V3_PHASES.map((phase) => canonicalPhaseFromState(
      phase,
      phase === 'total_validator_wall' ? totalState : this.#states.get(phase),
    ));
    const parseGaps = [];
    const parsed = parsePhases(phases, this.#clockDomainId, this.#outcome, parseGaps);
    const firstVisibleNs = this.#firstVisibleBoundary
      ? BigInt(this.#firstVisibleBoundary.monotonicNs)
      : null;
    const firstOutputReadyNs = this.#firstOutputReadyBoundary
      ? BigInt(this.#firstOutputReadyBoundary.monotonicNs)
      : null;
    const summary = deriveSummaryFromParsed(parsed, firstVisibleNs, firstOutputReadyNs);
    const record = {
      schema: GPU_HMR_TEST_TIMING_V3_SCHEMA,
      schemaVersion: GPU_HMR_TEST_TIMING_V3_SCHEMA_VERSION,
      recordId: null,
      clock: {
        kind: GPU_HMR_TEST_TIMING_V3_CLOCK,
        unit: GPU_HMR_TEST_TIMING_V3_UNIT,
        domainId: this.#clockDomainId,
        sourceManifestId: this.#clockSourceManifest.manifestId,
        sourceIdentityHash: this.#clockSourceManifest.clockSourceIdentityHash,
      },
      binding: structuredClone(this.#binding),
      modality: this.#modality,
      outcome: this.#outcome,
      authority: GPU_HMR_TEST_TIMING_V3_AUTHORITY,
      timingOnly: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      phases,
      firstVisibleBoundary: this.#firstVisibleBoundary
        ? structuredClone(this.#firstVisibleBoundary)
        : null,
      firstOutputReadyBoundary: this.#firstOutputReadyBoundary
        ? structuredClone(this.#firstOutputReadyBoundary)
        : null,
      summary,
    };
    record.recordId = recomputeGpuHmrTestTimingV3RecordId(record);
    const validation = validateGpuHmrTestTimingV3(record, {
      expectedBinding: this.#binding,
      trustedClockSourceManifest: this.#clockSourceManifest,
    });
    if (!validation.valid) {
      throw new GpuHmrTestTimingV3Error('timing_v3_record_invalid', {
        gaps: validation.gaps,
      });
    }
    this.#finalized = true;
    return deepFreeze(record);
  }
}

export function createGpuHmrTestTimingV3Recorder(options) {
  return new GpuHmrTestTimingV3Recorder(options);
}

function validatePersistencePlan(plan, timingRecordValidationOptions, scope, gaps) {
  const initialGapCount = gaps.length;
  if (!exactKeys(plan, PERSISTENCE_PLAN_KEYS, scope, gaps)) return null;
  if (plan.schema !== GPU_HMR_TEST_TIMING_V3_PERSISTENCE_PLAN_SCHEMA) {
    pushGap(gaps, `${scope}_schema_invalid`);
  }
  if (!primitiveStringMatches(plan.timingRecordId, RECORD_ID_PATTERN)) {
    pushGap(gaps, `${scope}_timing_record_id_invalid`);
  }
  for (const field of ['timingRecordHash', 'byteHash']) {
    if (!primitiveStringMatches(plan[field], HASH_PATTERN)) {
      pushGap(gaps, `${scope}_${field}_invalid`);
    }
  }
  if (
    !Number.isSafeInteger(plan.byteLength)
    || plan.byteLength <= 0
    || plan.byteLength > GPU_HMR_TEST_TIMING_V3_MAX_RECORD_BYTES
  ) {
    pushGap(gaps, `${scope}_byte_length_invalid`);
  }
  if (typeof plan.serializedRecord !== 'string') {
    pushGap(gaps, `${scope}_serialized_record_invalid`);
    return null;
  }
  if (plan.serializedRecord.length > GPU_HMR_TEST_TIMING_V3_MAX_RECORD_BYTES) {
    pushGap(gaps, `${scope}_serialized_record_limit_exceeded`);
    return null;
  }
  const byteLength = Buffer.byteLength(plan.serializedRecord, 'utf8');
  if (byteLength > GPU_HMR_TEST_TIMING_V3_MAX_RECORD_BYTES) {
    pushGap(gaps, `${scope}_serialized_record_limit_exceeded`);
    return null;
  }
  const byteHash = `sha256:${createHash('sha256')
    .update(plan.serializedRecord, 'utf8')
    .digest('hex')}`;
  if (byteLength !== plan.byteLength) pushGap(gaps, `${scope}_byte_length_mismatch`);
  if (byteHash !== plan.byteHash) pushGap(gaps, `${scope}_byte_hash_mismatch`);
  if (plan.timingRecordHash !== plan.byteHash) {
    pushGap(gaps, `${scope}_timing_record_hash_mismatch`);
  }
  try {
    const parsedRecord = JSON.parse(plan.serializedRecord);
    if (parsedRecord.recordId !== plan.timingRecordId) {
      pushGap(gaps, `${scope}_serialized_record_id_mismatch`);
    }
    const recordValidation = validateGpuHmrTestTimingV3(
      parsedRecord,
      timingRecordValidationOptions,
    );
    if (!recordValidation.valid) {
      pushGap(gaps, `${scope}_timing_record_invalid`);
      for (const gap of recordValidation.gaps) {
        pushGap(gaps, `${scope}_timing_record:${gap}`);
      }
    } else {
      if (canonicalJson(parsedRecord) !== plan.serializedRecord) {
        pushGap(gaps, `${scope}_serialized_record_not_canonical`);
      }
      if (recomputeGpuHmrTestTimingV3RecordId(parsedRecord) !== plan.timingRecordId) {
        pushGap(gaps, `${scope}_serialized_record_content_id_mismatch`);
      }
    }
  } catch {
    pushGap(gaps, `${scope}_serialized_record_json_invalid`);
  }
  if (!clockManifestIsPersistenceEligible(
    timingRecordValidationOptions?.trustedClockSourceManifest,
  )) {
    pushGap(gaps, `${scope}_timing_clock_not_persistence_eligible`);
  }
  return gaps.length === initialGapCount ? plan : null;
}

export function prepareGpuHmrTestTimingV3Persistence(record, validationOptions) {
  assertValidGpuHmrTestTimingV3(record, validationOptions);
  if (!clockManifestIsPersistenceEligible(validationOptions?.trustedClockSourceManifest)) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_ineligible_clock');
  }
  const serializedRecord = canonicalJson(record);
  const byteLength = Buffer.byteLength(serializedRecord, 'utf8');
  if (byteLength > GPU_HMR_TEST_TIMING_V3_MAX_RECORD_BYTES) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_record_limit_exceeded');
  }
  const byteHash = `sha256:${createHash('sha256')
    .update(serializedRecord, 'utf8')
    .digest('hex')}`;
  return deepFreeze({
    schema: GPU_HMR_TEST_TIMING_V3_PERSISTENCE_PLAN_SCHEMA,
    timingRecordId: record.recordId,
    timingRecordHash: byteHash,
    byteLength,
    byteHash,
    serializedRecord,
  });
}

function requirePersistenceOperation(
  persistenceOperation,
  code = 'timing_v3_persistence_operation_invalid',
) {
  const data = (
    persistenceOperation !== null
    && (typeof persistenceOperation === 'object' || typeof persistenceOperation === 'function')
  ) ? PERSISTENCE_OPERATION_DATA.get(persistenceOperation) : null;
  if (!data) throw new GpuHmrTestTimingV3Error(code);
  return data;
}

export function createGpuHmrTestTimingV3PersistenceOperation(input) {
  const gaps = [];
  if (!exactKeys(
    input,
    PERSISTENCE_OPERATION_INPUT_KEYS,
    'persistence_operation_input',
    gaps,
  )) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_operation_input_invalid', {
      gaps,
    });
  }
  const plan = validatePersistencePlan(
    input.persistencePlan,
    input.timingRecordValidationOptions,
    'persistence_operation_plan',
    gaps,
  );
  let writerCapabilityData = null;
  try {
    writerCapabilityData = requireClockCapability(
      input.writerClockCapability,
      'timing_v3_writer_clock_capability_invalid',
    );
  } catch {
    pushGap(gaps, 'writer_clock_capability_invalid');
  }
  const clockValidation = validateGpuHmrTestTimingV3ClockSourceManifest(
    writerCapabilityData?.manifest,
  );
  if (!clockValidation.valid) pushGap(gaps, 'writer_clock_source_manifest_invalid');
  if (!clockManifestIsPersistenceEligible(writerCapabilityData?.manifest)) {
    pushGap(gaps, 'writer_clock_not_persistence_eligible');
  }
  if (!stableId(input.writerIdentity)) pushGap(gaps, 'persistence_writerIdentity_invalid');
  if (!stableId(input.destinationIdentity)) {
    pushGap(gaps, 'persistence_destinationIdentity_invalid');
  }
  if (gaps.length > 0) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_operation_input_invalid', {
      gaps,
    });
  }

  const persistenceOperation = Object.freeze(Object.create(null));
  PERSISTENCE_OPERATION_DATA.set(persistenceOperation, {
    nonce: Object.freeze(Object.create(null)),
    persistencePlan: plan,
    planBinding: Object.freeze({
      timingRecordId: plan.timingRecordId,
      timingRecordHash: plan.timingRecordHash,
      byteLength: plan.byteLength,
      byteHash: plan.byteHash,
    }),
    writerClockCapability: input.writerClockCapability,
    writerIdentity: input.writerIdentity,
    destinationIdentity: input.destinationIdentity,
    nextReadingIndex: 0,
    issuedReadings: new Map(),
    receiptAttempted: false,
  });
  return persistenceOperation;
}

export function captureGpuHmrTestTimingV3ClockReading(persistenceOperation, stage) {
  const operation = requirePersistenceOperation(persistenceOperation);
  if (operation.receiptAttempted) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_operation_consumed');
  }
  const expectedStage = PERSISTENCE_READING_STAGES[operation.nextReadingIndex];
  if (stage !== expectedStage) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_clock_reading_order_invalid', {
      expectedStage: expectedStage ?? null,
    });
  }
  const monotonicNs = readClockCapabilityNs(operation.writerClockCapability);
  const writeStartData = CLOCK_READING_DATA.get(
    operation.issuedReadings.get('write_start'),
  );
  const writeEndData = CLOCK_READING_DATA.get(
    operation.issuedReadings.get('write_end'),
  );
  if (stage === 'write_end' && monotonicNs <= writeStartData.monotonicNs) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_write_duration_not_positive');
  }
  if (stage === 'read_verify' && monotonicNs < writeEndData.monotonicNs) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_read_before_write_end');
  }

  const reading = Object.freeze(Object.create(null));
  CLOCK_READING_DATA.set(reading, {
    persistenceOperation,
    nonce: operation.nonce,
    stage,
    monotonicNs,
    consumed: false,
  });
  operation.issuedReadings.set(stage, reading);
  operation.nextReadingIndex += 1;
  return reading;
}

function consumePersistenceClockReadings(input, verifiedAtReading, operation, gaps) {
  const requested = [
    ['write_start', 'persistence_write_start_reading', input?.writeStartReading],
    ['write_end', 'persistence_write_end_reading', input?.writeEndReading],
    [
      'read_verify',
      'persistence_verified_at_reading',
      verifiedAtReading,
    ],
  ];
  const seen = new Set();
  const recognized = new Set();
  const values = new Map();
  let operationReadingPresented = false;
  for (const [expectedStage, scope, reading] of requested) {
    const data = (
      reading !== null
      && (typeof reading === 'object' || typeof reading === 'function')
    ) ? CLOCK_READING_DATA.get(reading) : null;
    if (!data) {
      pushGap(gaps, `${scope}_invalid`);
      continue;
    }
    recognized.add(data);
    if (seen.has(reading)) pushGap(gaps, 'persistence_clock_reading_duplicate_token');
    seen.add(reading);
    if (data.consumed) pushGap(gaps, `${scope}_consumed`);
    if (
      data.persistenceOperation !== input.persistenceOperation
      || data.nonce !== operation.nonce
    ) {
      pushGap(gaps, `${scope}_operation_mismatch`);
      continue;
    }
    operationReadingPresented = true;
    if (data.stage !== expectedStage) pushGap(gaps, `${scope}_stage_mismatch`);
    if (operation.issuedReadings.get(expectedStage) !== reading) {
      pushGap(gaps, `${scope}_operation_token_mismatch`);
    }
    values.set(expectedStage, data.monotonicNs);
  }
  for (const data of recognized) data.consumed = true;
  if (operationReadingPresented) operation.receiptAttempted = true;
  return values;
}

function receiptId(receipt) {
  return `gpu-hmr-timing-persistence-receipt:sha256:${hashMaterial(
    materialWithoutId(receipt, 'receiptId'),
  )}`;
}

export function createGpuHmrTestTimingV3PersistenceReceipt(input) {
  const gaps = [];
  if (!exactKeys(input, RECEIPT_CREATE_KEYS, 'persistence_receipt_input', gaps)) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_receipt_input_invalid', {
      gaps,
    });
  }
  const plan = validatePersistencePlan(
    input?.persistencePlan,
    input?.timingRecordValidationOptions,
    'persistence_plan',
    gaps,
  );
  let operation = null;
  try {
    operation = requirePersistenceOperation(
      input.persistenceOperation,
      'timing_v3_persistence_operation_invalid',
    );
  } catch {
    pushGap(gaps, 'persistence_operation_invalid');
  }
  if (operation) {
    if (operation.receiptAttempted) pushGap(gaps, 'persistence_operation_consumed');
    if (operation.persistencePlan !== input.persistencePlan) {
      pushGap(gaps, 'persistence_operation_plan_identity_mismatch');
    }
    for (const field of ['timingRecordId', 'timingRecordHash', 'byteLength', 'byteHash']) {
      if (plan?.[field] !== operation.planBinding[field]) {
        pushGap(gaps, `persistence_operation_plan_mismatch:${field}`);
      }
    }
    if (operation.writerClockCapability !== input.writerClockCapability) {
      pushGap(gaps, 'persistence_operation_writer_clock_mismatch');
    }
    if (operation.writerIdentity !== input.writerIdentity) {
      pushGap(gaps, 'persistence_operation_writer_identity_mismatch');
    }
    if (operation.destinationIdentity !== input.destinationIdentity) {
      pushGap(gaps, 'persistence_operation_destination_mismatch');
    }
  }
  let writerCapabilityData = null;
  try {
    writerCapabilityData = requireClockCapability(
      input?.writerClockCapability,
      'timing_v3_writer_clock_capability_invalid',
    );
  } catch {
    pushGap(gaps, 'writer_clock_capability_invalid');
  }
  const clockValidation = validateGpuHmrTestTimingV3ClockSourceManifest(
    writerCapabilityData?.manifest,
  );
  if (!clockValidation.valid) pushGap(gaps, 'writer_clock_source_manifest_invalid');
  if (!clockManifestIsPersistenceEligible(writerCapabilityData?.manifest)) {
    pushGap(gaps, 'writer_clock_not_persistence_eligible');
  }
  for (const field of ['writerIdentity', 'destinationIdentity', 'writeSource']) {
    if (!stableId(input?.[field])) pushGap(gaps, `persistence_${field}_invalid`);
  }
  const readableAfterWriteShapeValid = exactKeys(
    input.readableAfterWrite,
    RECEIPT_READ_INPUT_KEYS,
    'persistence_readable_after_write',
    gaps,
  );
  const verifiedAtReading = readableAfterWriteShapeValid
    ? input.readableAfterWrite.verifiedAtReading
    : null;
  const readingValues = operation
    ? consumePersistenceClockReadings(input, verifiedAtReading, operation, gaps)
    : new Map();
  if (!readableAfterWriteShapeValid) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_receipt_input_invalid', {
      gaps,
    });
  }
  const writeStartNs = readingValues.get('write_start') ?? null;
  const writeEndNs = readingValues.get('write_end') ?? null;
  if (writeStartNs !== null && writeEndNs !== null && writeEndNs <= writeStartNs) {
    pushGap(gaps, 'persistence_write_duration_not_positive');
  }
  const writeEvidenceRefs = validateEvidenceRefs(
    input?.writeEvidenceRefs,
    'persistence_write',
    gaps,
  );
  if (input?.readableAfterWrite?.verified !== true) {
    pushGap(gaps, 'persistence_readable_after_write_not_verified');
  }
  const verifiedAtNs = readingValues.get('read_verify') ?? null;
  if (verifiedAtNs !== null && writeEndNs !== null && verifiedAtNs < writeEndNs) {
    pushGap(gaps, 'persistence_read_verification_before_write_end');
  }
  if (!stableId(input?.readableAfterWrite?.readerIdentity)) {
    pushGap(gaps, 'persistence_reader_identity_invalid');
  }
  if (input?.readableAfterWrite?.observedByteLength !== plan?.byteLength) {
    pushGap(gaps, 'persistence_read_byte_length_mismatch');
  }
  if (input?.readableAfterWrite?.observedByteHash !== plan?.byteHash) {
    pushGap(gaps, 'persistence_read_byte_hash_mismatch');
  }
  const readEvidenceRefs = validateEvidenceRefs(
    input?.readableAfterWrite?.evidenceRefs,
    'persistence_readable_after_write',
    gaps,
  );
  if (gaps.length > 0) {
    throw new GpuHmrTestTimingV3Error('timing_v3_persistence_receipt_input_invalid', {
      gaps,
    });
  }
  const manifest = writerCapabilityData.manifest;
  const receipt = {
    schema: GPU_HMR_TEST_TIMING_V3_PERSISTENCE_RECEIPT_SCHEMA,
    schemaVersion: 1,
    receiptId: null,
    timingRecordId: plan.timingRecordId,
    timingRecordHash: plan.timingRecordHash,
    writerIdentity: input.writerIdentity,
    processIdentity: manifest.processIdentity,
    runtimeSessionId: manifest.runtimeSessionId,
    destinationIdentity: input.destinationIdentity,
    byteLength: plan.byteLength,
    byteHash: plan.byteHash,
    clock: {
      kind: manifest.clockKind,
      unit: manifest.unit,
      domainId: manifest.clockDomainId,
      sourceManifestId: manifest.manifestId,
      sourceIdentityHash: manifest.clockSourceIdentityHash,
    },
    write: {
      startNs: writeStartNs.toString(),
      endNs: writeEndNs.toString(),
      durationNs: (writeEndNs - writeStartNs).toString(),
      source: input.writeSource,
      evidenceRefs: writeEvidenceRefs,
    },
    readableAfterWrite: {
      verified: true,
      verifiedAtNs: verifiedAtNs.toString(),
      readerIdentity: input.readableAfterWrite.readerIdentity,
      observedByteLength: input.readableAfterWrite.observedByteLength,
      observedByteHash: input.readableAfterWrite.observedByteHash,
      evidenceRefs: readEvidenceRefs,
    },
    authority: 'persistence_receipt_only_not_gpu_hmr_acceptance',
    timingOnly: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
  };
  receipt.receiptId = receiptId(receipt);
  return deepFreeze(receipt);
}

export function validateGpuHmrTestTimingV3PersistenceReceipt(receipt, options = {}) {
  const gaps = [];
  if (!assessBoundedMaterialAndAuthority(receipt, gaps)) {
    return deepFreeze({ valid: false, gaps, recomputedReceiptId: null });
  }
  if (!exactKeys(options, RECEIPT_VALIDATION_OPTION_KEYS, 'receipt_validation_options', gaps)) {
    return deepFreeze({ valid: false, gaps, recomputedReceiptId: null });
  }
  const plan = validatePersistencePlan(
    options.expectedPersistencePlan,
    options.timingRecordValidationOptions,
    'expected_persistence_plan',
    gaps,
  );
  let writerCapabilityData = null;
  try {
    writerCapabilityData = requireClockCapability(
      options.trustedWriterClockCapability,
      'timing_v3_writer_clock_capability_invalid',
    );
  } catch {
    pushGap(gaps, 'trusted_writer_clock_capability_invalid');
  }
  const clockValidation = validateGpuHmrTestTimingV3ClockSourceManifest(
    writerCapabilityData?.manifest,
  );
  if (!clockValidation.valid) pushGap(gaps, 'trusted_writer_clock_source_manifest_invalid');
  if (!clockManifestIsPersistenceEligible(writerCapabilityData?.manifest)) {
    pushGap(gaps, 'trusted_writer_clock_not_persistence_eligible');
  }
  if (!stableId(options.expectedWriterIdentity)) pushGap(gaps, 'expected_writer_identity_invalid');
  if (!stableId(options.expectedDestinationIdentity)) {
    pushGap(gaps, 'expected_destination_identity_invalid');
  }
  exactKeys(receipt, RECEIPT_KEYS, 'persistence_receipt', gaps);
  if (receipt?.schema !== GPU_HMR_TEST_TIMING_V3_PERSISTENCE_RECEIPT_SCHEMA) {
    pushGap(gaps, 'persistence_receipt_schema_invalid');
  }
  if (receipt?.schemaVersion !== 1) pushGap(gaps, 'persistence_receipt_version_invalid');
  if (receipt?.authority !== 'persistence_receipt_only_not_gpu_hmr_acceptance') {
    pushGap(gaps, 'persistence_receipt_authority_invalid');
  }
  if (receipt?.timingOnly !== true) pushGap(gaps, 'persistence_receipt_timing_only_invalid');
  if (receipt?.acceptedForGpuHmr !== false) pushGap(gaps, 'persistence_receipt_acceptance_claim');
  if (receipt?.gpuHmrSuccess !== false) pushGap(gaps, 'persistence_receipt_success_claim');
  if (plan) {
    for (const field of ['timingRecordId', 'timingRecordHash', 'byteLength', 'byteHash']) {
      if (receipt?.[field] !== plan[field]) pushGap(gaps, `persistence_receipt_replay:${field}`);
    }
  }
  if (receipt?.writerIdentity !== options.expectedWriterIdentity) {
    pushGap(gaps, 'persistence_receipt_writer_replay');
  }
  if (receipt?.destinationIdentity !== options.expectedDestinationIdentity) {
    pushGap(gaps, 'persistence_receipt_destination_replay');
  }
  const manifest = writerCapabilityData?.manifest;
  if (clockValidation.valid) {
    if (receipt?.processIdentity !== manifest.processIdentity) {
      pushGap(gaps, 'persistence_receipt_process_identity_mismatch');
    }
    if (receipt?.runtimeSessionId !== manifest.runtimeSessionId) {
      pushGap(gaps, 'persistence_receipt_runtime_session_mismatch');
    }
    if (exactKeys(receipt?.clock, CLOCK_KEYS, 'persistence_receipt_clock', gaps)) {
      for (const [field, expected] of [
        ['kind', manifest.clockKind],
        ['unit', manifest.unit],
        ['domainId', manifest.clockDomainId],
        ['sourceManifestId', manifest.manifestId],
        ['sourceIdentityHash', manifest.clockSourceIdentityHash],
      ]) {
        if (receipt.clock[field] !== expected) {
          pushGap(gaps, `persistence_receipt_clock_mismatch:${field}`);
        }
      }
    }
  }
  if (exactKeys(receipt?.write, RECEIPT_WRITE_KEYS, 'persistence_receipt_write', gaps)) {
    const startNs = canonicalNs(receipt.write.startNs);
    const endNs = canonicalNs(receipt.write.endNs);
    const durationNs = canonicalNs(receipt.write.durationNs);
    if (startNs === null) pushGap(gaps, 'persistence_receipt_write_start_invalid');
    if (endNs === null) pushGap(gaps, 'persistence_receipt_write_end_invalid');
    if (durationNs === null) pushGap(gaps, 'persistence_receipt_write_duration_invalid');
    if (startNs !== null && endNs !== null && endNs <= startNs) {
      pushGap(gaps, 'persistence_receipt_write_duration_not_positive');
    }
    if (
      startNs !== null
      && endNs !== null
      && durationNs !== null
      && endNs > startNs
      && durationNs !== endNs - startNs
    ) {
      pushGap(gaps, 'persistence_receipt_write_duration_mismatch');
    }
    if (!stableId(receipt.write.source)) pushGap(gaps, 'persistence_receipt_write_source_invalid');
    validateEvidenceRefs(receipt.write.evidenceRefs, 'persistence_receipt_write', gaps);
    if (exactKeys(
      receipt?.readableAfterWrite,
      RECEIPT_READ_KEYS,
      'persistence_receipt_read',
      gaps,
    )) {
      const verifiedAtNs = canonicalNs(receipt.readableAfterWrite.verifiedAtNs);
      if (receipt.readableAfterWrite.verified !== true) {
        pushGap(gaps, 'persistence_receipt_read_not_verified');
      }
      if (verifiedAtNs === null) pushGap(gaps, 'persistence_receipt_verified_at_invalid');
      if (verifiedAtNs !== null && endNs !== null && verifiedAtNs < endNs) {
        pushGap(gaps, 'persistence_receipt_read_before_write_end');
      }
      if (!stableId(receipt.readableAfterWrite.readerIdentity)) {
        pushGap(gaps, 'persistence_receipt_reader_identity_invalid');
      }
      if (receipt.readableAfterWrite.observedByteLength !== receipt.byteLength) {
        pushGap(gaps, 'persistence_receipt_read_byte_length_mismatch');
      }
      if (receipt.readableAfterWrite.observedByteHash !== receipt.byteHash) {
        pushGap(gaps, 'persistence_receipt_read_byte_hash_mismatch');
      }
      validateEvidenceRefs(
        receipt.readableAfterWrite.evidenceRefs,
        'persistence_receipt_read',
        gaps,
      );
    }
  }
  let recomputedReceiptId = null;
  try {
    recomputedReceiptId = receiptId(receipt);
    if (!primitiveStringMatches(receipt?.receiptId, RECEIPT_ID_PATTERN)) {
      pushGap(gaps, 'persistence_receipt_id_format_invalid');
    }
    if (receipt?.receiptId !== recomputedReceiptId) {
      pushGap(gaps, 'persistence_receipt_id_mismatch');
    }
  } catch {
    pushGap(gaps, 'persistence_receipt_material_invalid');
  }
  return deepFreeze({ valid: gaps.length === 0, gaps, recomputedReceiptId });
}
