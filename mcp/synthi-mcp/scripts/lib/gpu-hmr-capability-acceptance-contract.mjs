import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

import {
  evaluateGpuHmrRuntimeAdapterCapabilitiesVersionedIntegrity,
} from './gpu-hmr-runtime-adapter-capabilities-versioned.mjs';
import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2,
  deriveGpuHmrRuntimeAdapterCapabilityObligationsV2,
} from './gpu-hmr-runtime-adapter-capabilities-v2.mjs';

export const GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SCHEMA_VERSION =
  'synthi.gpu_hmr.capability_acceptance_contract.v2';
export const GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_AUTHORITY =
  'capability_derived_declaration_only_not_evidence_runtime_dispatch_or_gpu_hmr_acceptance';
export const GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INTEGRITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.capability_acceptance_contract_integrity.v2';
export const GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INTEGRITY_AUTHORITY =
  'capability_acceptance_contract_integrity_only_not_evidence_runtime_dispatch_or_gpu_hmr_acceptance';

export const GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INPUT_FIELDS = Object.freeze([
  'subjectBinding',
  'capabilityFacet',
]);

export const GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SUBJECT_FIELDS = Object.freeze([
  'sourceManifestHash',
  'editHash',
  'artifactBeforeHash',
  'artifactAfterHash',
]);

export const GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_FIELDS = Object.freeze([
  'schemaVersion',
  'authority',
  'subjectBinding',
  'subjectBindingHash',
  'capabilityFacet',
  'capabilityBindingHash',
  'obligations',
  'contractHash',
  'proofId',
  'valid',
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]);

export const GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_ARRAY_LENGTH = 128;
export const GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_OBJECT_FIELDS = 64;
export const GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_DEPTH = 32;
export const GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_NODES = 4096;
export const GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_FIELDS = 8192;
export const GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_STRING_BYTES = 4096;
export const GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_TOTAL_STRING_BYTES =
  256 * 1024;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CONTRACT_FIELD_SET = new Set(GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_FIELDS);

function fail(code, detail = '') {
  const suffix = detail === '' ? '' : `:${detail}`;
  throw new TypeError(`gpu_hmr_capability_acceptance_contract_${code}${suffix}`);
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

function assertBoundedString(value, path, state) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (
    bytes > GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_STRING_BYTES
    || hasUnpairedSurrogate(value)
  ) {
    fail('plain_data_string_invalid', path);
  }
  state.stringBytes += bytes;
  if (
    state.stringBytes
    > GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_TOTAL_STRING_BYTES
  ) {
    fail('plain_data_total_string_bytes_exceeded', path);
  }
}

function assertBoundedOwnEnumerableFieldCount(value, limit, code, path) {
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    if (count > limit) fail(code, path);
  }
}

function boundedOwnKeys(value, limit, code, path) {
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail('plain_data_introspection_failed', path);
  }
  if (keys.length > limit) fail(code, path);
  return keys;
}

function assertBoundedPlainData(root, label) {
  const active = new Set();
  const complete = new Set();
  const state = { nodes: 0, fields: 0, stringBytes: 0 };
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
    if (complete.has(value)) fail('plain_data_duplicate_alias_forbidden', entry.path);
    if (entry.depth > GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_DEPTH) {
      fail('plain_data_depth_exceeded', entry.path);
    }

    state.nodes += 1;
    if (state.nodes > GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_NODES) {
      fail('plain_data_nodes_exceeded', label);
    }

    let prototype;
    let isArray;
    try {
      prototype = Object.getPrototypeOf(value);
      isArray = Array.isArray(value);
    } catch {
      fail('plain_data_introspection_failed', entry.path);
    }

    if (isArray) {
      if (prototype !== Array.prototype) {
        fail('plain_data_array_prototype_invalid', entry.path);
      }
      let lengthDescriptor;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      } catch {
        fail('plain_data_introspection_failed', entry.path);
      }
      const length = lengthDescriptor?.value;
      if (
        !lengthDescriptor
        || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(length)
        || length < 0
        || length > GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_ARRAY_LENGTH
      ) {
        fail('plain_data_array_shape_invalid', entry.path);
      }
      assertBoundedOwnEnumerableFieldCount(
        value,
        length,
        'plain_data_array_shape_invalid',
        entry.path,
      );

      const keys = boundedOwnKeys(
        value,
        length + 1,
        'plain_data_array_shape_invalid',
        entry.path,
      );
      if (keys.some((key) => typeof key !== 'string')) {
        fail('plain_data_symbol_key_forbidden', entry.path);
      }
      if (keys.length !== length + 1) {
        fail('plain_data_array_shape_invalid', entry.path);
      }

      active.add(value);
      pending.push({ ...entry, leave: true });
      state.fields += length;
      if (state.fields > GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_FIELDS) {
        fail('plain_data_fields_exceeded', label);
      }
      for (let index = length - 1; index >= 0; index -= 1) {
        let descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        } catch {
          fail('plain_data_introspection_failed', `${entry.path}[${index}]`);
        }
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

    if (prototype !== Object.prototype) {
      fail('plain_data_object_prototype_invalid', entry.path);
    }
    assertBoundedOwnEnumerableFieldCount(
      value,
      GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_OBJECT_FIELDS,
      'plain_data_object_fields_exceeded',
      entry.path,
    );

    const keys = boundedOwnKeys(
      value,
      GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_OBJECT_FIELDS,
      'plain_data_object_fields_exceeded',
      entry.path,
    );
    if (keys.some((key) => typeof key !== 'string')) {
      fail('plain_data_symbol_key_forbidden', entry.path);
    }
    if (keys.length > GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_OBJECT_FIELDS) {
      fail('plain_data_object_fields_exceeded', entry.path);
    }
    active.add(value);
    pending.push({ ...entry, leave: true });
    state.fields += keys.length;
    if (state.fields > GPU_HMR_CAPABILITY_ACCEPTANCE_MAX_PLAIN_DATA_FIELDS) {
      fail('plain_data_fields_exceeded', label);
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      assertBoundedString(key, `${entry.path}.[key]`, state);
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        fail('plain_data_introspection_failed', `${entry.path}.${key}`);
      }
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

function normalizeSubjectBinding(value) {
  const source = requireExactRecord(
    value,
    GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SUBJECT_FIELDS,
    'subject_binding',
  );
  const subjectBinding = Object.freeze({
    sourceManifestHash: requireCanonicalHash(
      source.sourceManifestHash,
      'source_manifest_hash',
    ),
    editHash: requireCanonicalHash(source.editHash, 'edit_hash'),
    artifactBeforeHash: requireCanonicalHash(
      source.artifactBeforeHash,
      'artifact_before_hash',
    ),
    artifactAfterHash: requireCanonicalHash(
      source.artifactAfterHash,
      'artifact_after_hash',
    ),
  });
  if (subjectBinding.artifactBeforeHash === subjectBinding.artifactAfterHash) {
    fail('artifact_transition_unchanged');
  }
  return subjectBinding;
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

function contractHashMaterial(contract) {
  return {
    schemaVersion: contract.schemaVersion,
    authority: contract.authority,
    subjectBinding: contract.subjectBinding,
    subjectBindingHash: contract.subjectBindingHash,
    capabilityFacet: contract.capabilityFacet,
    capabilityBindingHash: contract.capabilityBindingHash,
    obligations: contract.obligations,
    valid: contract.valid,
    acceptedAsSupportEvidence: contract.acceptedAsSupportEvidence,
    acceptedForGpuHmr: contract.acceptedForGpuHmr,
    gpuHmrSuccess: contract.gpuHmrSuccess,
    canSatisfyRuntimeProof: contract.canSatisfyRuntimeProof,
    canSatisfyDispatchProof: contract.canSatisfyDispatchProof,
  };
}

export function createGpuHmrCapabilityAcceptanceContract(input) {
  assertBoundedPlainData(input, 'input');
  const source = requireExactRecord(
    input,
    GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INPUT_FIELDS,
    'input',
  );
  const subjectBinding = normalizeSubjectBinding(source.subjectBinding);

  const facetIntegrity = evaluateGpuHmrRuntimeAdapterCapabilitiesVersionedIntegrity(
    source.capabilityFacet,
  );
  const capabilityEnvelope = facetIntegrity.recomputedEnvelope;
  if (!facetIntegrity.valid || capabilityEnvelope === null) {
    fail('capability_facet_integrity_invalid');
  }
  if (
    capabilityEnvelope.historical === true
    || capabilityEnvelope.schemaVersion
      !== GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION
  ) {
    fail('capability_facet_current_version_required');
  }
  const capabilityFacet = cloneAndFreeze(capabilityEnvelope.facet);
  const capabilityFacts = Object.fromEntries(
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITY_FACT_FIELDS_V2.map(
      (field) => [field, capabilityFacet[field]],
    ),
  );
  const obligations = Object.freeze([
    ...deriveGpuHmrRuntimeAdapterCapabilityObligationsV2(capabilityFacts),
  ]);
  if (stableJson(obligations) !== stableJson(capabilityFacet.obligations)) {
    fail('capability_obligations_mismatch');
  }

  const subjectBindingHash = canonicalSha256({
    domain: `${GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SCHEMA_VERSION}.subject_binding`,
    subjectBinding,
  });
  const declaration = {
    schemaVersion: GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    authority: GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_AUTHORITY,
    subjectBinding,
    subjectBindingHash,
    capabilityFacet,
    capabilityBindingHash: capabilityFacet.bindingHash,
    obligations,
    valid: true,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  const contractHash = canonicalSha256({
    domain: `${GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_SCHEMA_VERSION}.contract`,
    contract: contractHashMaterial(declaration),
  });

  return Object.freeze({
    schemaVersion: declaration.schemaVersion,
    authority: declaration.authority,
    subjectBinding: declaration.subjectBinding,
    subjectBindingHash: declaration.subjectBindingHash,
    capabilityFacet: declaration.capabilityFacet,
    capabilityBindingHash: declaration.capabilityBindingHash,
    obligations: declaration.obligations,
    contractHash,
    proofId: `gpu-hmr-capability-acceptance-contract:${contractHash}`,
    valid: declaration.valid,
    acceptedAsSupportEvidence: declaration.acceptedAsSupportEvidence,
    acceptedForGpuHmr: declaration.acceptedForGpuHmr,
    gpuHmrSuccess: declaration.gpuHmrSuccess,
    canSatisfyRuntimeProof: declaration.canSatisfyRuntimeProof,
    canSatisfyDispatchProof: declaration.canSatisfyDispatchProof,
  });
}

export const declareGpuHmrCapabilityAcceptanceContract =
  createGpuHmrCapabilityAcceptanceContract;

function integrityResult(failures, recomputedContract = null) {
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  const valid = uniqueFailures.length === 0 && recomputedContract !== null;
  return Object.freeze({
    schemaVersion:
      GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INTEGRITY_SCHEMA_VERSION,
    authority: GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_INTEGRITY_AUTHORITY,
    valid,
    acceptedAsSupportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    failures: uniqueFailures,
    recomputedContract: valid ? recomputedContract : null,
  });
}

export function evaluateGpuHmrCapabilityAcceptanceContractIntegrity(contract) {
  try {
    assertBoundedPlainData(contract, 'contract');
  } catch (error) {
    return integrityResult([
      error instanceof Error ? error.message : 'plain_data_invalid',
    ]);
  }

  let source;
  try {
    source = requireExactRecord(
      contract,
      GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_FIELDS,
      'contract',
    );
  } catch (error) {
    return integrityResult([
      error instanceof Error ? error.message : 'field_set_invalid',
    ]);
  }

  const failures = [];
  if (
    source.acceptedAsSupportEvidence !== false
    || source.acceptedForGpuHmr !== false
    || source.gpuHmrSuccess !== false
    || source.canSatisfyRuntimeProof !== false
    || source.canSatisfyDispatchProof !== false
  ) {
    failures.push('gpu_hmr_capability_acceptance_contract_authority_claim_forbidden');
  }

  let recomputedContract;
  try {
    recomputedContract = createGpuHmrCapabilityAcceptanceContract({
      subjectBinding: source.subjectBinding,
      capabilityFacet: source.capabilityFacet,
    });
  } catch {
    failures.push('gpu_hmr_capability_acceptance_contract_retained_input_invalid');
    return integrityResult(failures);
  }

  for (const field of GPU_HMR_CAPABILITY_ACCEPTANCE_CONTRACT_FIELDS) {
    if (stableJson(source[field]) !== stableJson(recomputedContract[field])) {
      failures.push(`gpu_hmr_capability_acceptance_contract_${field}_mismatch`);
    }
  }
  return integrityResult(
    failures,
    failures.length === 0 ? recomputedContract : null,
  );
}
