import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS,
  deriveGpuHmrRuntimeAdapterCapabilityObligations,
  evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity,
} from './gpu-hmr-runtime-adapter-capabilities.mjs';

// This protocol transports caller-declared verifier outcomes for structural audit only.
// The declarations are not authenticated, trusted evidence, or proof of GPU HMR success.
export const GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION =
  'synthi.gpu_hmr.capability_evidence_projection.v1';
export const GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_AUTHORITY =
  'caller_declared_outcome_audit_transport_only_not_authenticated_evidence';
export const GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INTEGRITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.capability_evidence_projection_integrity.v1';
export const GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INTEGRITY_AUTHORITY =
  'declared_outcome_audit_transport_integrity_only_not_evidence_authority';

export const GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INPUT_FIELDS = Object.freeze([
  'capabilityFacet',
  'verifierOutcomes',
]);

export const GPU_HMR_CAPABILITY_VERIFIER_OUTCOME_FIELDS = Object.freeze([
  'obligation',
  'satisfied',
  'evidenceRefs',
  'verifierSchemaHash',
  'verifierId',
  'verifierBindingHash',
]);

export const GPU_HMR_CAPABILITY_VERIFIER_OUTCOME_BINDING_FIELDS = Object.freeze([
  'capabilityBindingHash',
  'obligation',
  'satisfied',
  'evidenceRefs',
  'verifierSchemaHash',
  'verifierId',
]);

export const GPU_HMR_CAPABILITY_EVIDENCE_MAX_OUTCOMES = 52;
export const GPU_HMR_CAPABILITY_EVIDENCE_MAX_REFS_PER_OUTCOME = 64;
export const GPU_HMR_CAPABILITY_EVIDENCE_MAX_REF_BYTES = 1024;

const MAX_PLAIN_DATA_ARRAY_LENGTH = 128;
const MAX_PLAIN_DATA_OBJECT_FIELDS = 64;
const MAX_PLAIN_DATA_DEPTH = 32;
const MAX_PLAIN_DATA_NODES = 4096;
const MAX_PLAIN_DATA_STRING_BYTES = 4096;
const MAX_PLAIN_DATA_TOTAL_STRING_BYTES = 256 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OBLIGATION_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const PROJECTION_FIELDS = Object.freeze([
  'schemaVersion',
  'authority',
  'capabilityFacet',
  'capabilityBindingHash',
  'obligations',
  'verifierOutcomes',
  'allDeclaredVerifierOutcomesSatisfied',
  'outcomesHash',
  'projectionHash',
  'proofId',
  'valid',
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]);

function fail(code, detail = '') {
  const suffix = detail === '' ? '' : `:${String(detail)}`;
  throw new TypeError(`gpu_hmr_capability_evidence_projection_${code}${suffix}`);
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

function assertBoundedString(value, label, state) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_PLAIN_DATA_STRING_BYTES || hasUnpairedSurrogate(value)) {
    fail('plain_data_string_invalid', label);
  }
  state.totalStringBytes += bytes;
  if (state.totalStringBytes > MAX_PLAIN_DATA_TOTAL_STRING_BYTES) {
    fail('plain_data_total_string_bytes_exceeded', label);
  }
}

function assertBoundedPlainData(root, label) {
  const active = new Set();
  const complete = new Set();
  const state = { nodes: 0, totalStringBytes: 0 };
  const pending = [{ value: root, depth: 0, path: label, leave: false }];

  while (pending.length > 0) {
    const entry = pending.pop();
    const value = entry.value;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') {
      assertBoundedString(value, entry.path, state);
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        fail('plain_data_number_invalid', entry.path);
      }
      continue;
    }
    if (typeof value !== 'object') fail('plain_data_type_invalid', entry.path);

    let isProxy;
    try {
      isProxy = utilTypes.isProxy(value);
    } catch {
      fail('plain_data_introspection_failed', entry.path);
    }
    if (isProxy) fail('plain_data_proxy_forbidden', entry.path);
    if (entry.leave) {
      active.delete(value);
      complete.add(value);
      continue;
    }
    if (active.has(value)) fail('plain_data_cycle_forbidden', entry.path);
    if (complete.has(value)) continue;
    if (entry.depth > MAX_PLAIN_DATA_DEPTH) {
      fail('plain_data_depth_exceeded', entry.path);
    }
    state.nodes += 1;
    if (state.nodes > MAX_PLAIN_DATA_NODES) fail('plain_data_nodes_exceeded', label);

    let descriptors;
    let keys;
    let prototype;
    let isArray;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
      keys = Reflect.ownKeys(descriptors);
      prototype = Object.getPrototypeOf(value);
      isArray = Array.isArray(value);
    } catch {
      fail('plain_data_introspection_failed', entry.path);
    }
    if (keys.some((key) => typeof key !== 'string')) {
      fail('plain_data_symbol_key_forbidden', entry.path);
    }
    active.add(value);
    pending.push({ ...entry, leave: true });

    if (isArray) {
      if (prototype !== Array.prototype) fail('plain_data_array_prototype_invalid', entry.path);
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor?.value;
      if (
        !lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(length)
        || length < 0
        || length > MAX_PLAIN_DATA_ARRAY_LENGTH
        || keys.length !== length + 1
      ) {
        fail('plain_data_array_shape_invalid', entry.path);
      }
      for (let index = length - 1; index >= 0; index -= 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor
          || !Object.hasOwn(descriptor, 'value')
          || descriptor.enumerable !== true
        ) {
          fail('plain_data_sparse_or_accessor_array', `${entry.path}[${index}]`);
        }
        pending.push({
          value: descriptor.value,
          depth: entry.depth + 1,
          path: `${entry.path}[${index}]`,
          leave: false,
        });
      }
      continue;
    }

    if (prototype !== Object.prototype) fail('plain_data_object_prototype_invalid', entry.path);
    if (keys.length > MAX_PLAIN_DATA_OBJECT_FIELDS) {
      fail('plain_data_object_fields_exceeded', entry.path);
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      assertBoundedString(key, `${entry.path}.[key]`, state);
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        fail('plain_data_accessor_or_hidden_field', `${entry.path}.${key}`);
      }
      pending.push({
        value: descriptor.value,
        depth: entry.depth + 1,
        path: `${entry.path}.${key}`,
        leave: false,
      });
    }
  }
}

function requireExactRecord(value, fields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label}_must_be_record`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const accepted = new Set(fields);
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== 'string' || !accepted.has(key))
    || fields.some((field) => !Object.hasOwn(descriptors, field))
  ) {
    fail(`${label}_field_set_mismatch`);
  }
  return Object.fromEntries(fields.map((field) => [field, descriptors[field].value]));
}

function requireCanonicalHash(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${label}_invalid`);
  }
  return value;
}

function requireObligation(value) {
  if (typeof value !== 'string' || !OBLIGATION_PATTERN.test(value)) {
    fail('outcome_obligation_invalid');
  }
  return value;
}

function requireEvidenceRefs(value, satisfied) {
  if (!Array.isArray(value)) fail('outcome_evidence_refs_must_be_array');
  if (
    value.length > GPU_HMR_CAPABILITY_EVIDENCE_MAX_REFS_PER_OUTCOME
    || (satisfied && value.length === 0)
  ) {
    fail('outcome_evidence_refs_length_invalid');
  }
  const refs = [];
  for (let index = 0; index < value.length; index += 1) {
    const reference = value[index];
    if (
      typeof reference !== 'string'
      || reference.length === 0
      || reference !== reference.trim()
      || Buffer.byteLength(reference, 'utf8') > GPU_HMR_CAPABILITY_EVIDENCE_MAX_REF_BYTES
      || /[\p{Cc}\u2028\u2029]/u.test(reference)
      || hasUnpairedSurrogate(reference)
    ) {
      fail('outcome_evidence_ref_invalid', index);
    }
    if (index > 0 && compareStrings(refs[index - 1], reference) >= 0) {
      fail('outcome_evidence_refs_not_sorted_unique');
    }
    refs.push(reference);
  }
  return Object.freeze(refs);
}

function normalizeOutcomeBindingInput(value) {
  assertBoundedPlainData(value, 'outcomeBinding');
  const source = requireExactRecord(
    value,
    GPU_HMR_CAPABILITY_VERIFIER_OUTCOME_BINDING_FIELDS,
    'outcome_binding',
  );
  if (typeof source.satisfied !== 'boolean') fail('outcome_satisfied_invalid');
  return Object.freeze({
    capabilityBindingHash: requireCanonicalHash(
      source.capabilityBindingHash,
      'capability_binding_hash',
    ),
    obligation: requireObligation(source.obligation),
    satisfied: source.satisfied,
    evidenceRefs: requireEvidenceRefs(source.evidenceRefs, source.satisfied),
    verifierSchemaHash: requireCanonicalHash(
      source.verifierSchemaHash,
      'verifier_schema_hash',
    ),
    verifierId: requireCanonicalHash(source.verifierId, 'verifier_id'),
  });
}

export function deriveGpuHmrCapabilityVerifierOutcomeBindingHash(input) {
  const binding = normalizeOutcomeBindingInput(input);
  return canonicalSha256({
    domain: `${GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION}.verifier_outcome_binding`,
    ...binding,
  });
}

function normalizeVerifierOutcome(value, capabilityBindingHash, expectedObligation) {
  const source = requireExactRecord(
    value,
    GPU_HMR_CAPABILITY_VERIFIER_OUTCOME_FIELDS,
    'verifier_outcome',
  );
  const obligation = requireObligation(source.obligation);
  if (obligation !== expectedObligation) fail('verifier_outcomes_not_canonical');
  if (typeof source.satisfied !== 'boolean') fail('outcome_satisfied_invalid');
  const evidenceRefs = requireEvidenceRefs(source.evidenceRefs, source.satisfied);
  const verifierSchemaHash = requireCanonicalHash(
    source.verifierSchemaHash,
    'verifier_schema_hash',
  );
  const verifierId = requireCanonicalHash(source.verifierId, 'verifier_id');
  const verifierBindingHash = requireCanonicalHash(
    source.verifierBindingHash,
    'verifier_binding_hash',
  );
  const expectedBindingHash = deriveGpuHmrCapabilityVerifierOutcomeBindingHash({
    capabilityBindingHash,
    obligation,
    satisfied: source.satisfied,
    evidenceRefs,
    verifierSchemaHash,
    verifierId,
  });
  if (verifierBindingHash !== expectedBindingHash) fail('verifier_binding_hash_mismatch');
  return Object.freeze({
    obligation,
    satisfied: source.satisfied,
    evidenceRefs,
    verifierSchemaHash,
    verifierId,
    verifierBindingHash,
  });
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.keys(value).map((key) => [key, cloneAndFreeze(value[key])]),
    ));
  }
  return value;
}

export function projectGpuHmrCapabilityEvidence(input) {
  assertBoundedPlainData(input, 'input');
  const source = requireExactRecord(
    input,
    GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INPUT_FIELDS,
    'input',
  );
  const facetIntegrity = evaluateGpuHmrRuntimeAdapterCapabilitiesIntegrity(
    source.capabilityFacet,
  );
  if (!facetIntegrity.valid || facetIntegrity.recomputedFacet === null) {
    fail('capability_facet_integrity_invalid');
  }
  const capabilityFacet = cloneAndFreeze(facetIntegrity.recomputedFacet);
  const capabilityFacts = Object.fromEntries(
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS.map(
      (field) => [field, capabilityFacet[field]],
    ),
  );
  const obligations = deriveGpuHmrRuntimeAdapterCapabilityObligations(capabilityFacts);

  if (!Array.isArray(source.verifierOutcomes)) fail('verifier_outcomes_must_be_array');
  if (
    source.verifierOutcomes.length !== obligations.length
    || source.verifierOutcomes.length > GPU_HMR_CAPABILITY_EVIDENCE_MAX_OUTCOMES
  ) {
    fail('verifier_outcomes_cardinality_mismatch');
  }
  const verifierOutcomes = Object.freeze(source.verifierOutcomes.map(
    (outcome, index) => normalizeVerifierOutcome(
      outcome,
      capabilityFacet.bindingHash,
      obligations[index],
    ),
  ));
  const canonicalObligations = Object.freeze([...obligations]);
  const allDeclaredVerifierOutcomesSatisfied = verifierOutcomes.every(
    (outcome) => outcome.satisfied,
  );
  const outcomesHash = canonicalSha256({
    domain: `${GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION}.outcomes`,
    capabilityBindingHash: capabilityFacet.bindingHash,
    verifierOutcomes,
  });
  const projectionHash = canonicalSha256({
    schemaVersion: GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION,
    authority: GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_AUTHORITY,
    capabilityBindingHash: capabilityFacet.bindingHash,
    obligations: canonicalObligations,
    verifierOutcomes,
    allDeclaredVerifierOutcomesSatisfied,
    outcomesHash,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  });

  return Object.freeze({
    schemaVersion: GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_SCHEMA_VERSION,
    authority: GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_AUTHORITY,
    capabilityFacet,
    capabilityBindingHash: capabilityFacet.bindingHash,
    obligations: canonicalObligations,
    verifierOutcomes,
    allDeclaredVerifierOutcomesSatisfied,
    outcomesHash,
    projectionHash,
    proofId: `capability-evidence-projection:${projectionHash}`,
    valid: true,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  });
}

function integrityResult(failures, recomputedProjection = null) {
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  const valid = uniqueFailures.length === 0 && recomputedProjection !== null;
  return Object.freeze({
    schemaVersion: GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INTEGRITY_SCHEMA_VERSION,
    authority: GPU_HMR_CAPABILITY_EVIDENCE_PROJECTION_INTEGRITY_AUTHORITY,
    valid,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    failures: uniqueFailures,
    recomputedProjection: valid ? recomputedProjection : null,
  });
}

export function evaluateGpuHmrCapabilityEvidenceProjectionIntegrity(projection) {
  try {
    assertBoundedPlainData(projection, 'projection');
  } catch (error) {
    return integrityResult([error instanceof Error ? error.message : 'plain_data_invalid']);
  }
  let source;
  try {
    source = requireExactRecord(projection, PROJECTION_FIELDS, 'projection');
  } catch (error) {
    return integrityResult([error instanceof Error ? error.message : 'field_set_invalid']);
  }

  const failures = [];
  if (
    source.acceptedAsSupportEvidence !== false
    || source.acceptedForGpuHmr !== false
    || source.gpuHmrSuccess !== false
    || source.canSatisfyRuntimeProof !== false
    || source.canSatisfyDispatchProof !== false
  ) {
    failures.push('capability_evidence_projection_success_authority_forbidden');
  }

  let recomputedProjection;
  try {
    recomputedProjection = projectGpuHmrCapabilityEvidence({
      capabilityFacet: source.capabilityFacet,
      verifierOutcomes: source.verifierOutcomes,
    });
  } catch {
    failures.push('capability_evidence_projection_retained_input_invalid');
    return integrityResult(failures);
  }
  for (const field of PROJECTION_FIELDS) {
    if (stableJson(source[field]) !== stableJson(recomputedProjection[field])) {
      failures.push(`capability_evidence_projection_${field}_mismatch`);
    }
  }
  return integrityResult(failures, failures.length === 0 ? recomputedProjection : null);
}
