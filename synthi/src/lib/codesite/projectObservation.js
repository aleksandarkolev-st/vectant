import { createHash } from 'crypto';

export const PROJECT_OBSERVATION_SCHEMA_VERSION = 'synthi.codesite.projectObservation.v1';

export const PROJECT_OBSERVATION_EVENT_TYPES = Object.freeze([
  'source_changed',
  'runtime_observed',
  'inspection_failed',
]);

export const PROJECT_OBSERVATION_PRODUCER_KINDS = Object.freeze([
  'codesite_landing',
  'crdt_flush',
  'governed_patch',
  'filesystem_adapter',
  'terminal_adapter',
  'program_runtime_adapter',
  'preview_adapter',
  'test_runner',
  'inspection_runner',
  'mcp_adapter',
]);

export const SOURCE_CHANGE_KINDS = Object.freeze([
  'landed',
  'crdt_flush',
  'governed_patch',
  'quarantine_applied',
]);

export const RUNTIME_OBSERVATION_KINDS = Object.freeze([
  'started',
  'ready',
  'state_changed',
  'exited',
  'crashed',
  'health_changed',
  'ports_changed',
  'compile_applied',
  'compile_failed',
  'reload_required',
  'runtime_error',
  'spawn_failed',
  'watcher_failed',
]);

export const RUNTIME_STATES = Object.freeze([
  'starting',
  'running',
  'ready',
  'stopped',
  'crashed',
  'healthy',
  'unhealthy',
  'failed',
  'unknown',
]);

export const INSPECTION_KINDS = Object.freeze([
  'test',
  'security',
  'review',
  'build',
  'typecheck',
  'lint',
]);

const EVENT_TYPE_SET = new Set(PROJECT_OBSERVATION_EVENT_TYPES);
const PRODUCER_KIND_SET = new Set(PROJECT_OBSERVATION_PRODUCER_KINDS);
const SOURCE_CHANGE_KIND_SET = new Set(SOURCE_CHANGE_KINDS);
const RUNTIME_OBSERVATION_KIND_SET = new Set(RUNTIME_OBSERVATION_KINDS);
const RUNTIME_STATE_SET = new Set(RUNTIME_STATES);
const INSPECTION_KIND_SET = new Set(INSPECTION_KINDS);

const TOP_LEVEL_KEYS = new Set([
  'eventType',
  'projectId',
  'producer',
  'occurredAt',
  'causalParentIds',
  'refs',
  'providerSessionBound',
  'evidenceRefs',
  'fact',
]);
const PRODUCER_KEYS = new Set(['kind', 'eventId']);
const REFERENCE_KEYS = new Set([
  'transactionIds',
  'mutationLeaseIds',
  'agentSessionIds',
  'runtimeSessionIds',
  'executionPlanIds',
  'inspectionRunIds',
  'paths',
  'symbols',
  'contracts',
  'process',
]);
const PROCESS_KEYS = new Set(['pid', 'parentPid', 'ancestry']);
const PROCESS_ANCESTOR_KEYS = new Set(['pid', 'parentPid', 'imageDigest']);
const SOURCE_FACT_KEYS = new Set([
  'changeKind',
  'proofBundleId',
  'proofBundleDigest',
  'repoStateDigest',
  'reasonCodes',
]);
const RUNTIME_FACT_KEYS = new Set([
  'observationKind',
  'runtimeState',
  'exitCode',
  'signal',
  'healthState',
  'ports',
  'reasonCodes',
]);
const INSPECTION_FACT_KEYS = new Set([
  'inspectionKind',
  'status',
  'exitCode',
  'timedOut',
  'failingSignalKeys',
  'reasonCodes',
]);

const PRIVATE_KEY_PARTS = Object.freeze([
  'raw',
  'output',
  'stdout',
  'stderr',
  'message',
  'command',
  'env',
  'environment',
  'prompt',
  'transcript',
  'token',
  'providersessionref',
]);

const SECRET_VALUE_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\b(?:authorization|proxy-authorization|x-api-key)\s*[:=]\s*(?:bearer\s+)?\S+/i,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd)\s*[:=]\s*["']?\S+/i,
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /\b(?:sk|rk|pk)-[a-z0-9_-]{16,}\b/i,
  /\bgh(?:p|o|u|s|r)_[a-z0-9]{20,}\b/i,
  /\bgithub_pat_[a-z0-9_]{20,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/,
  /(?:https?|ssh|postgres(?:ql)?|mysql|redis):\/\/[^\s/@:]+:[^\s/@]+@/i,
]);

const MAX_DEPTH = 24;
const MAX_NODES = 5_000;
const MAX_ID_LENGTH = 256;
const MAX_REF_LENGTH = 1_024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@#-]*$/;
const SAFE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/;

export class ProjectObservationValidationError extends Error {
  constructor(code, path, details = null) {
    super(code);
    this.name = 'ProjectObservationValidationError';
    this.code = code;
    this.status = 422;
    this.path = path;
    this.details = details;
  }
}

function validationError(code, path, details = null) {
  return new ProjectObservationValidationError(code, path, details);
}

function normalizedKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPrivateKey(key) {
  const normalized = normalizedKey(key);
  return PRIVATE_KEY_PARTS.some((part) => normalized === part || normalized.startsWith(part) || normalized.endsWith(part));
}

function hasSecretValue(value) {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function scanPrivateMaterial(value, path = '$', state = { nodes: 0 }, depth = 0, seen = new WeakSet()) {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) {
    throw validationError('project_observation_too_complex', path);
  }
  if (typeof value === 'string') {
    if (hasSecretValue(value)) {
      throw validationError('project_observation_private_material_rejected', path, { reason: 'secret_value' });
    }
    return;
  }
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw validationError('project_observation_not_serializable', path);
    return;
  }
  if (typeof value !== 'object') throw validationError('project_observation_not_serializable', path);
  if (seen.has(value)) throw validationError('project_observation_not_serializable', path, { reason: 'cycle' });
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw validationError('project_observation_not_serializable', path, { reason: 'non_plain_object' });
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPrivateMaterial(item, `${path}[${index}]`, state, depth + 1, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      const itemPath = `${path}.${key}`;
      if (isPrivateKey(key)) {
        throw validationError('project_observation_private_material_rejected', itemPath, { reason: 'private_field' });
      }
      scanPrivateMaterial(item, itemPath, state, depth + 1, seen);
    }
  }
  seen.delete(value);
}

function requirePlainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw validationError('project_observation_object_required', path);
  }
  return value;
}

function rejectUnknownKeys(value, allowedKeys, path) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw validationError('project_observation_field_not_allowed', `${path}.${key}`);
    }
  }
}

function requiredString(value, path, { max = MAX_ID_LENGTH, pattern = SAFE_ID } = {}) {
  if (typeof value !== 'string') throw validationError('project_observation_string_required', path);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || !pattern.test(normalized)) {
    throw validationError('project_observation_string_invalid', path);
  }
  return normalized;
}

function optionalString(value, path, options = {}) {
  if (value == null) return null;
  return requiredString(value, path, options);
}

function enumValue(value, allowed, path) {
  const normalized = requiredString(value, path);
  if (!allowed.has(normalized)) throw validationError('project_observation_value_not_allowed', path);
  return normalized;
}

function uniqueSortedStrings(value, path, options = {}) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw validationError('project_observation_array_required', path);
  return [...new Set(value.map((item, index) => requiredString(item, `${path}[${index}]`, options)))].sort();
}

function optionalInteger(value, path, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw validationError('project_observation_integer_invalid', path);
  }
  return value;
}

function requiredBoolean(value, path) {
  if (typeof value !== 'boolean') throw validationError('project_observation_boolean_required', path);
  return value;
}

function normalizeOccurredAt(value) {
  if (typeof value !== 'string') throw validationError('project_observation_timestamp_required', '$.occurredAt');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw validationError('project_observation_timestamp_invalid', '$.occurredAt');
  return parsed.toISOString();
}

function normalizeProjectPath(value, path) {
  const raw = requiredString(value, path, { max: MAX_REF_LENGTH, pattern: /^\S+$/ });
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  if (!normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').some((part) => part === '..' || part === '')
    || normalized.includes('\0')) {
    throw validationError('project_observation_path_invalid', path);
  }
  return normalized;
}

function normalizePaths(value, path) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw validationError('project_observation_array_required', path);
  return [...new Set(value.map((item, index) => normalizeProjectPath(item, `${path}[${index}]`)))].sort();
}

function normalizeProcess(value) {
  if (value == null) return null;
  const process = requirePlainObject(value, '$.refs.process');
  rejectUnknownKeys(process, PROCESS_KEYS, '$.refs.process');
  const pid = optionalInteger(process.pid, '$.refs.process.pid', { min: 1 });
  const parentPid = optionalInteger(process.parentPid, '$.refs.process.parentPid', { min: 0 });
  const ancestryInput = process.ancestry == null ? [] : process.ancestry;
  if (!Array.isArray(ancestryInput)) throw validationError('project_observation_array_required', '$.refs.process.ancestry');
  const ancestry = ancestryInput.map((item, index) => {
    const path = `$.refs.process.ancestry[${index}]`;
    const ancestor = requirePlainObject(item, path);
    rejectUnknownKeys(ancestor, PROCESS_ANCESTOR_KEYS, path);
    const ancestorPid = optionalInteger(ancestor.pid, `${path}.pid`, { min: 1 });
    if (ancestorPid == null) throw validationError('project_observation_integer_invalid', `${path}.pid`);
    return {
      pid: ancestorPid,
      parentPid: optionalInteger(ancestor.parentPid, `${path}.parentPid`, { min: 0 }),
      imageDigest: optionalString(ancestor.imageDigest, `${path}.imageDigest`, { max: MAX_REF_LENGTH, pattern: SAFE_DIGEST }),
    };
  });
  if (pid == null && ancestry.length === 0) {
    throw validationError('project_observation_process_identity_required', '$.refs.process');
  }
  return { pid, parentPid, ancestry };
}

function normalizeReferences(value) {
  const refs = value == null ? {} : requirePlainObject(value, '$.refs');
  rejectUnknownKeys(refs, REFERENCE_KEYS, '$.refs');
  return {
    transactionIds: uniqueSortedStrings(refs.transactionIds, '$.refs.transactionIds'),
    mutationLeaseIds: uniqueSortedStrings(refs.mutationLeaseIds, '$.refs.mutationLeaseIds'),
    agentSessionIds: uniqueSortedStrings(refs.agentSessionIds, '$.refs.agentSessionIds'),
    runtimeSessionIds: uniqueSortedStrings(refs.runtimeSessionIds, '$.refs.runtimeSessionIds'),
    executionPlanIds: uniqueSortedStrings(refs.executionPlanIds, '$.refs.executionPlanIds'),
    inspectionRunIds: uniqueSortedStrings(refs.inspectionRunIds, '$.refs.inspectionRunIds'),
    paths: normalizePaths(refs.paths, '$.refs.paths'),
    symbols: uniqueSortedStrings(refs.symbols, '$.refs.symbols', { max: MAX_REF_LENGTH, pattern: SAFE_ID }),
    contracts: uniqueSortedStrings(refs.contracts, '$.refs.contracts', { max: MAX_REF_LENGTH, pattern: SAFE_ID }),
    process: normalizeProcess(refs.process),
  };
}

function normalizeProducer(value) {
  const producer = requirePlainObject(value, '$.producer');
  rejectUnknownKeys(producer, PRODUCER_KEYS, '$.producer');
  return {
    kind: enumValue(producer.kind, PRODUCER_KIND_SET, '$.producer.kind'),
    eventId: requiredString(producer.eventId, '$.producer.eventId', { max: MAX_REF_LENGTH, pattern: SAFE_ID }),
  };
}

function normalizeReasonCodes(value, path) {
  return uniqueSortedStrings(value, path, { max: MAX_ID_LENGTH, pattern: SAFE_ID });
}

function normalizeSourceFact(value) {
  const fact = requirePlainObject(value, '$.fact');
  rejectUnknownKeys(fact, SOURCE_FACT_KEYS, '$.fact');
  return {
    changeKind: enumValue(fact.changeKind, SOURCE_CHANGE_KIND_SET, '$.fact.changeKind'),
    proofBundleId: optionalString(fact.proofBundleId, '$.fact.proofBundleId'),
    proofBundleDigest: optionalString(fact.proofBundleDigest, '$.fact.proofBundleDigest', { max: MAX_REF_LENGTH, pattern: SAFE_DIGEST }),
    repoStateDigest: optionalString(fact.repoStateDigest, '$.fact.repoStateDigest', { max: MAX_REF_LENGTH, pattern: SAFE_DIGEST }),
    reasonCodes: normalizeReasonCodes(fact.reasonCodes, '$.fact.reasonCodes'),
  };
}

function normalizeRuntimeFact(value) {
  const fact = requirePlainObject(value, '$.fact');
  rejectUnknownKeys(fact, RUNTIME_FACT_KEYS, '$.fact');
  const healthState = fact.healthState == null
    ? null
    : enumValue(fact.healthState, new Set(['unknown', 'ok', 'unhealthy']), '$.fact.healthState');
  const portsInput = fact.ports == null ? [] : fact.ports;
  if (!Array.isArray(portsInput)) throw validationError('project_observation_array_required', '$.fact.ports');
  const ports = [...new Set(portsInput.map((port, index) => {
    const normalized = optionalInteger(port, `$.fact.ports[${index}]`, { min: 1, max: 65_535 });
    if (normalized == null) throw validationError('project_observation_integer_invalid', `$.fact.ports[${index}]`);
    return normalized;
  }))].sort((left, right) => left - right);
  return {
    observationKind: enumValue(fact.observationKind, RUNTIME_OBSERVATION_KIND_SET, '$.fact.observationKind'),
    runtimeState: fact.runtimeState == null ? null : enumValue(fact.runtimeState, RUNTIME_STATE_SET, '$.fact.runtimeState'),
    exitCode: optionalInteger(fact.exitCode, '$.fact.exitCode', { min: -1, max: 255 }),
    signal: optionalString(fact.signal, '$.fact.signal'),
    healthState,
    ports,
    reasonCodes: normalizeReasonCodes(fact.reasonCodes, '$.fact.reasonCodes'),
  };
}

function normalizeInspectionFact(value) {
  const fact = requirePlainObject(value, '$.fact');
  rejectUnknownKeys(fact, INSPECTION_FACT_KEYS, '$.fact');
  if (fact.status !== 'failed') {
    throw validationError('project_observation_value_not_allowed', '$.fact.status');
  }
  return {
    inspectionKind: fact.inspectionKind == null ? null : enumValue(fact.inspectionKind, INSPECTION_KIND_SET, '$.fact.inspectionKind'),
    status: 'failed',
    exitCode: optionalInteger(fact.exitCode, '$.fact.exitCode', { min: -1, max: 255 }),
    timedOut: fact.timedOut == null ? false : requiredBoolean(fact.timedOut, '$.fact.timedOut'),
    failingSignalKeys: uniqueSortedStrings(fact.failingSignalKeys, '$.fact.failingSignalKeys'),
    reasonCodes: normalizeReasonCodes(fact.reasonCodes, '$.fact.reasonCodes'),
  };
}

function normalizeFact(eventType, value) {
  if (eventType === 'source_changed') return normalizeSourceFact(value);
  if (eventType === 'runtime_observed') return normalizeRuntimeFact(value);
  return normalizeInspectionFact(value);
}

function enforceReferenceRequirements(eventType, refs) {
  if (eventType === 'source_changed'
    && refs.paths.length === 0
    && refs.symbols.length === 0
    && refs.contracts.length === 0) {
    throw validationError('project_observation_source_reference_required', '$.refs');
  }
  if (eventType === 'runtime_observed'
    && refs.runtimeSessionIds.length === 0
    && refs.process == null) {
    throw validationError('project_observation_runtime_reference_required', '$.refs');
  }
  if (eventType === 'inspection_failed'
    && refs.inspectionRunIds.length === 0
    && refs.executionPlanIds.length === 0) {
    throw validationError('project_observation_inspection_reference_required', '$.refs');
  }
}

function stableObservationId(projectId, eventType, producer) {
  const identity = JSON.stringify({
    eventType,
    producerEventId: producer.eventId,
    producerKind: producer.kind,
    projectId,
  });
  return `obs_${createHash('sha256').update(identity).digest('hex')}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function normalizeTypedObservation(input, requiredEventType = null) {
  scanPrivateMaterial(input);
  const source = requirePlainObject(input, '$');
  rejectUnknownKeys(source, TOP_LEVEL_KEYS, '$');
  const eventType = enumValue(source.eventType || requiredEventType, EVENT_TYPE_SET, '$.eventType');
  if (requiredEventType && eventType !== requiredEventType) {
    throw validationError('project_observation_event_type_mismatch', '$.eventType');
  }
  const projectId = requiredString(source.projectId, '$.projectId');
  const producer = normalizeProducer(source.producer);
  const refs = normalizeReferences(source.refs);
  enforceReferenceRequirements(eventType, refs);
  const providerSessionBound = source.providerSessionBound == null
    ? false
    : requiredBoolean(source.providerSessionBound, '$.providerSessionBound');
  const normalized = {
    schemaVersion: PROJECT_OBSERVATION_SCHEMA_VERSION,
    id: stableObservationId(projectId, eventType, producer),
    projectId,
    eventType,
    producer,
    occurredAt: normalizeOccurredAt(source.occurredAt),
    causalParentIds: uniqueSortedStrings(source.causalParentIds, '$.causalParentIds'),
    payload: {
      references: refs,
      providerSessionBound,
      evidenceRefs: uniqueSortedStrings(source.evidenceRefs, '$.evidenceRefs', { max: MAX_REF_LENGTH, pattern: SAFE_DIGEST }),
      fact: normalizeFact(eventType, source.fact),
    },
  };
  scanPrivateMaterial(normalized);
  return deepFreeze(normalized);
}

export function normalizeProjectObservation(input) {
  return normalizeTypedObservation(input);
}

export function normalizeSourceChangedObservation(input) {
  return normalizeTypedObservation(input, 'source_changed');
}

export function normalizeRuntimeObservedObservation(input) {
  return normalizeTypedObservation(input, 'runtime_observed');
}

export function normalizeInspectionFailedObservation(input) {
  return normalizeTypedObservation(input, 'inspection_failed');
}

const OBSERVATION_EVENT_TYPES = Object.freeze({
  source_changed: 'source_changed_observed',
  runtime_observed: 'runtime_observed',
  inspection_failed: 'inspection_failed',
});

const OBSERVATION_FACT_KEYS = Object.freeze({
  source_changed: ['changeKind', 'proofBundleId', 'proofBundleDigest', 'repoStateDigest', 'reasonCodes'],
  runtime_observed: ['observationKind', 'runtimeState', 'exitCode', 'signal', 'healthState', 'ports', 'reasonCodes'],
  inspection_failed: ['inspectionKind', 'status', 'exitCode', 'timedOut', 'failingSignalKeys', 'reasonCodes'],
});

export function observationEventType(eventType) {
  const canonical = String(eventType || '').trim();
  return OBSERVATION_EVENT_TYPES[canonical] || null;
}

export function observationFactPayload(observation, eventType = null) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return null;
  const canonical = String(eventType || observation.eventType || '').trim();
  if (eventType && canonical !== String(observation.eventType || '').trim()) return null;
  const keys = OBSERVATION_FACT_KEYS[canonical];
  if (!keys || !observation.payload || typeof observation.payload !== 'object') return null;
  const fact = observation.payload.fact;
  if (!fact || typeof fact !== 'object') return null;
  const payload = {};
  for (const key of keys) {
    if (fact[key] != null) payload[key] = fact[key];
  }
  return payload;
}

export function buildObservationCoordinationInput(observation, { actorId = null } = {}) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return null;
  const eventType = observationEventType(observation.eventType);
  if (!eventType) return null;
  const references = observation.payload?.references || {};
  const fact = observationFactPayload(observation);
  if (!fact) return null;
  return {
    eventType,
    displayCallsign: null,
    actorType: 'adapter',
    actorId,
    mutationLeaseId: references.mutationLeaseIds?.[0] || null,
    details: {
      observationId: observation.id,
      schemaVersion: observation.schemaVersion,
      producer: observation.producer || null,
      occurredAt: observation.occurredAt,
      causalParentIds: observation.causalParentIds || [],
      providerSessionBound: observation.payload?.providerSessionBound === true,
      references,
      fact,
    },
    evidenceRefs: observation.payload?.evidenceRefs || [],
  };
}

