import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  open,
  readFile,
  realpath,
  stat as statPath,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import {
  CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
  casRelativePathForHash,
  validateArtifactCasManifest,
} from './gpu-hmr-artifact-cas.mjs';

export const COMPUTE_ORACLE_ARTIFACT_BUNDLE_VERIFICATION_SCHEMA_VERSION =
  'synthi.gpu_hmr.compute_oracle_artifact_bundle_verification.v3';
export const COMPUTE_ORACLE_ARTIFACT_BUNDLE_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_oracle_artifact_bundle.v3';
export const COMPUTE_ORACLE_ARTIFACT_SET_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_oracle_artifact_set.v1';
export const COMPUTE_READBACK_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_readback_schema.v2';
export const COMPUTE_RUNTIME_CONTEXT_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_oracle_runtime_context.v1';
export const COMPUTE_PACKED_LAYOUT_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_readback_packed_layout.v1';
export const COMPUTE_PROOF_CARD_BINDING_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_proof_card_binding.v2';
export const COMPUTE_RENDERER_IDENTITY_SCHEMA_VERSION =
  'synthi.gpu.hmr.renderer_executable_identity.v2';
export const COMPUTE_CODEC_CONTRACT_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_dtype_codec_contract.v1';
export const COMPUTE_ORACLE_PROVENANCE_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_oracle_provenance.v1';

const COMPUTE_ORACLE_ARTIFACT_BUNDLE_AUTHORITY =
  'compute_oracle_before_after_artifact_bytes_only_not_gpu_hmr_acceptance';
const COMPUTE_RENDERER_KIND = 'deterministic_readback_slice_card';
const COMPUTE_RENDERER_CONTRACT_VERSION =
  'synthi.gpu.hmr.deterministic_compute_proof_card_renderer.v1';
const CARD_WIDTH = 256;
const CARD_HEIGHT = 128;
const CARD_CHANNELS = 4;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9._:@/-]{1,512}$/;
const SUCCESS_STATE_VALUES = new Set([
  'accepted',
  'full_runtime_proven',
  'gpu_hmr_accepted',
  'gpu_hmr_success',
  'passed',
  'proven',
  'succeeded',
  'success',
]);
const BENIGN_STATE_VALUES = new Set([
  'captured',
  'not_evaluated',
  'pending',
  'produced',
  'refused',
  'unavailable',
  'unknown',
]);
const SUPPORT_AUTHORITIES = new Set([
  COMPUTE_ORACLE_ARTIFACT_BUNDLE_AUTHORITY,
  'transport_integrity_only',
]);
const EXACT_FALSE_CLAIM_FIELDS = new Set([
  'acceptedforgpuhmr',
  'cansatisfydispatchproof',
  'cansatisfyruntimeproof',
  'fullruntimeproven',
  'gpuhmrsuccess',
  'outputoracleauthority',
  'runtimeproofauthority',
  'strictruntimeproofaccepted',
]);
const EXACT_STATUS_FIELDS = new Set(['status', 'verdict', 'resultstate']);

const CANONICAL_DTYPE_WIDTHS = new Map([
  ['bool', 1],
  ['i8', 1],
  ['u8', 1],
  ['bf16', 2],
  ['f16', 2],
  ['i16', 2],
  ['u16', 2],
  ['f32', 4],
  ['i32', 4],
  ['u32', 4],
  ['complex64', 8],
  ['f64', 8],
  ['i64', 8],
  ['u64', 8],
  ['complex128', 16],
]);

export const COMPUTE_ORACLE_CANONICAL_DTYPE_WIDTHS = Object.freeze(
  Object.fromEntries(CANONICAL_DTYPE_WIDTHS),
);

const LIMIT_DEFAULTS = Object.freeze({
  maxRawReadbackBytes: 64 * 1024 * 1024 * 1024,
  maxReadbackSchemaBytes: 1024 * 1024,
  maxRenderedCardBytes: 16 * 1024 * 1024,
  maxLocatorManifestBytes: 512 * 1024,
  maxDeterministicSliceBytes: 64 * 1024 * 1024,
  maxSerializedJsonBytes: 2 * 1024 * 1024,
  maxStringBytes: 256 * 1024,
  maxJsonDepth: 32,
  maxJsonEntries: 8192,
  maxProofCardPixels: 4 * 1024 * 1024,
  hashChunkBytes: 1024 * 1024,
  metadataChunkBytes: 64 * 1024,
});

const LIMIT_HARD_MAXIMUMS = Object.freeze({
  maxRawReadbackBytes: 1024 * 1024 * 1024 * 1024,
  maxReadbackSchemaBytes: 4 * 1024 * 1024,
  maxRenderedCardBytes: 64 * 1024 * 1024,
  maxLocatorManifestBytes: 2 * 1024 * 1024,
  maxDeterministicSliceBytes: 128 * 1024 * 1024,
  maxSerializedJsonBytes: 4 * 1024 * 1024,
  maxStringBytes: 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonEntries: 32768,
  maxProofCardPixels: 16 * 1024 * 1024,
  hashChunkBytes: 16 * 1024 * 1024,
  metadataChunkBytes: 1024 * 1024,
});

const RUNTIME_CONTEXT_FIELDS = Object.freeze([
  { camel: 'sourceManifestHash', snake: 'source_manifest_hash', kind: 'hash' },
  { camel: 'editId', snake: 'edit_id', kind: 'text' },
  { camel: 'editHash', snake: 'edit_hash', kind: 'hash' },
  { camel: 'changedArtifactHash', snake: 'changed_artifact_hash', kind: 'hash' },
  { camel: 'processId', snake: 'process_id', kind: 'text' },
  { camel: 'runtimeSession', snake: 'runtime_session', kind: 'text' },
  { camel: 'epoch', snake: 'epoch', kind: 'text' },
  { camel: 'dispatchId', snake: 'dispatch_id', kind: 'text' },
  { camel: 'outputTarget', snake: 'output_target', kind: 'text' },
  { camel: 'oracleCodeHash', snake: 'oracle_code_hash', kind: 'hash' },
  {
    camel: 'dispatchTimestampMonotonicNs',
    snake: 'dispatch_timestamp_monotonic_ns',
    kind: 'monotonic_ns',
  },
  {
    camel: 'timestampAfterDispatchMonotonicNs',
    snake: 'timestamp_after_dispatch_monotonic_ns',
    kind: 'monotonic_ns',
  },
]);

const ARTIFACT_ROLE_TEMPLATES = Object.freeze([
  { key: 'rawReadback', snake: 'raw_readback', suffix: 'raw_readback', artifactKind: 'compute_readback', mediaType: 'application/octet-stream' },
  { key: 'readbackSchema', snake: 'readback_schema', suffix: 'readback_schema', artifactKind: 'compute_readback_schema', mediaType: 'application/json' },
  { key: 'renderedCard', snake: 'rendered_card', suffix: 'rendered_card', artifactKind: 'compute_proof_card', mediaType: 'image/png' },
]);

const ARTIFACT_ROLES = Object.freeze(['before', 'after'].flatMap((phase) => (
  ARTIFACT_ROLE_TEMPLATES.map((template) => ({
    ...template,
    phase,
    role: `${phase}_${template.suffix}`,
  }))
)));
const RECOGNIZED_LOCATOR_ROLES = new Set(ARTIFACT_ROLES.map(({ role }) => role));

const BUNDLE_FIELDS = new Set([
  'schemaVersion',
  'schema_version',
  'before',
  'after',
  'artifactCasLocators',
  'artifact_cas_locators',
  'provenance',
  'proofAuthority',
  'proof_authority',
  'acceptedForGpuHmr',
  'accepted_for_gpu_hmr',
  'gpuHmrSuccess',
  'gpu_hmr_success',
  'canSatisfyRuntimeProof',
  'can_satisfy_runtime_proof',
  'canSatisfyDispatchProof',
  'can_satisfy_dispatch_proof',
  'fullRuntimeProven',
  'full_runtime_proven',
  'strictRuntimeProofAccepted',
  'strict_runtime_proof_accepted',
  'runtimeProofAuthority',
  'runtime_proof_authority',
  'outputOracleAuthority',
  'output_oracle_authority',
  'status',
  'verdict',
  'resultState',
  'result_state',
]);
const ARTIFACT_SET_FIELDS = new Set([
  'schemaVersion',
  'schema_version',
  ...ARTIFACT_ROLE_TEMPLATES.flatMap(({ key, snake }) => [key, snake]),
]);
const ARTIFACT_DECLARATION_FIELDS = new Set([
  'path',
  'casLocator',
  'cas_locator',
  'casLocatorManifestPath',
  'cas_locator_manifest_path',
  'contentHash',
  'content_hash',
  'byteLength',
  'byte_length',
]);
const READBACK_SCHEMA_FIELDS = new Set([
  'schemaVersion',
  'schema_version',
  'dtype',
  'shape',
  'elementCount',
  'element_count',
  'byteLength',
  'byte_length',
  'byteOrder',
  'byte_order',
  'layout',
  'rawReadbackHash',
  'raw_readback_hash',
  'deterministicSlice',
  'deterministic_slice',
  'runtimeContext',
  'runtime_context',
  'proofCardBinding',
  'proof_card_binding',
]);
const DTYPE_FIELDS = new Set(['name', 'byteWidth', 'byte_width', 'codecContract', 'codec_contract']);
const LAYOUT_FIELDS = new Set([
  'schemaVersion',
  'schema_version',
  'kind',
  'elementStrideBytes',
  'element_stride_bytes',
  'paddingBytes',
  'padding_bytes',
  'contiguous',
]);
const SLICE_FIELDS = new Set([
  'offset',
  'byteOffset',
  'byte_offset',
  'length',
  'byteLength',
  'byte_length',
  'hash',
  'sliceHash',
  'slice_hash',
]);
const RUNTIME_CONTEXT_FIELDS_ALLOWED = new Set([
  'schemaVersion',
  'schema_version',
  'contextHash',
  'context_hash',
  ...RUNTIME_CONTEXT_FIELDS.flatMap(({ camel, snake }) => [camel, snake]),
]);
const CARD_BINDING_FIELDS = new Set([
  'schemaVersion',
  'schema_version',
  'rawReadbackHash',
  'raw_readback_hash',
  'deterministicSliceHash',
  'deterministic_slice_hash',
  'schemaDerivationHash',
  'schema_derivation_hash',
  'renderedCardHash',
  'rendered_card_hash',
  'rendererExecutable',
  'renderer_executable',
  'derivationHash',
  'derivation_hash',
  'bindingHash',
  'binding_hash',
]);
const RENDERER_IDENTITY_FIELDS = new Set([
  'schemaVersion',
  'schema_version',
  'rendererKind',
  'renderer_kind',
  'rendererContractVersion',
  'renderer_contract_version',
  'moduleHash',
  'module_hash',
  'sharpVersion',
  'sharp_version',
  'vipsVersion',
  'vips_version',
  'executableHash',
  'executable_hash',
  'artifactId',
  'artifact_id',
]);
const CODEC_CONTRACT_FIELDS = new Set([
  'schemaVersion',
  'schema_version',
  'dtypeName',
  'dtype_name',
  'byteWidth',
  'byte_width',
  'byteOrder',
  'byte_order',
  'layoutKind',
  'layout_kind',
  'executableHash',
  'executable_hash',
  'artifactId',
  'artifact_id',
  'contractHash',
  'contract_hash',
]);
const PROVENANCE_FIELDS = new Set([
  'schemaVersion',
  'schema_version',
  'producerId',
  'producer_id',
  'producerArtifactHash',
  'producer_artifact_hash',
  'sessionNamespace',
  'session_namespace',
  'evidenceRefs',
  'evidence_refs',
]);

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256Object(value) {
  return sha256Bytes(Buffer.from(stableJson(value), 'utf8'));
}

function normalizeHash(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SHA256_RE.test(normalized) ? normalized : null;
}

function normalizeAliasKey(value) {
  return String(value ?? '').replace(/_/g, '').toLowerCase();
}

function comparableValue(value) {
  if (value instanceof URL) return JSON.stringify(value.href);
  try {
    return stableJson(value);
  } catch {
    return null;
  }
}

function ownAliasEntries(source, fields) {
  if (!objectOrNull(source)) return [];
  return fields
    .filter((field) => Object.prototype.hasOwnProperty.call(source, field))
    .map((field) => ({ field, value: source[field] }));
}

function aliasValue(source, fields, fail, conflictCode) {
  const entries = ownAliasEntries(source, fields);
  if (entries.length === 0) return { present: false, conflict: false, value: null, entries };
  const serialized = entries.map(({ value }) => comparableValue(value));
  if (serialized.some((value) => value === null) || new Set(serialized).size !== 1) {
    fail(conflictCode);
    return { present: true, conflict: true, value: null, entries };
  }
  return { present: true, conflict: false, value: entries[0].value, entries };
}

function collectAliasConflicts(value, rootPath = '$') {
  const conflicts = [];
  const visited = new WeakSet();
  const stack = [{ value, path: rootPath }];
  while (stack.length > 0) {
    const current = stack.pop();
    const entry = current.value;
    if (!entry || typeof entry !== 'object' || Buffer.isBuffer(entry) || entry instanceof URL) continue;
    if (visited.has(entry)) continue;
    visited.add(entry);
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => stack.push({ value: child, path: `${current.path}[${index}]` }));
      continue;
    }
    const groups = new Map();
    for (const [key, child] of Object.entries(entry)) {
      const normalized = normalizeAliasKey(key);
      const group = groups.get(normalized) ?? [];
      group.push({ key, child });
      groups.set(normalized, group);
      stack.push({ value: child, path: `${current.path}.${key}` });
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const serialized = group.map(({ child }) => comparableValue(child));
      if (serialized.some((item) => item === null) || new Set(serialized).size !== 1) {
        conflicts.push({
          path: current.path,
          fields: group.map(({ key }) => key).sort(),
        });
      }
    }
  }
  return conflicts;
}

function rejectUnknownFields(source, allowed, fail, code) {
  if (!objectOrNull(source)) return [];
  const unknown = Object.keys(source).filter((field) => !allowed.has(field)).sort();
  if (unknown.length > 0) fail(code);
  return unknown;
}

function inspectSerializedBounds(value, limits) {
  let entries = 0;
  let maximumDepth = 0;
  let serializedBytes = 0;
  let maximumStringBytes = 0;
  const visited = new WeakSet();
  const stack = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    maximumDepth = Math.max(maximumDepth, current.depth);
    if (maximumDepth > limits.maxJsonDepth) {
      return { accepted: false, reason: 'json_depth_limit_exceeded', entries, maximumDepth, serializedBytes, maximumStringBytes };
    }
    const entry = current.value;
    if (typeof entry === 'string' || entry instanceof URL) {
      const stringBytes = Buffer.byteLength(entry instanceof URL ? entry.href : entry, 'utf8');
      maximumStringBytes = Math.max(maximumStringBytes, stringBytes);
      serializedBytes += stringBytes + 2;
      if (stringBytes > limits.maxStringBytes) {
        return { accepted: false, reason: 'string_byte_limit_exceeded', entries, maximumDepth, serializedBytes, maximumStringBytes };
      }
    } else if (entry === null || typeof entry !== 'object') {
      serializedBytes += Buffer.byteLength(JSON.stringify(entry) ?? 'null', 'utf8');
    } else if (!Buffer.isBuffer(entry)) {
      if (visited.has(entry)) {
        return { accepted: false, reason: 'json_cycle_detected', entries, maximumDepth, serializedBytes, maximumStringBytes };
      }
      visited.add(entry);
      const children = Array.isArray(entry) ? entry.map((child) => [null, child]) : Object.entries(entry);
      entries += children.length;
      if (entries > limits.maxJsonEntries) {
        return { accepted: false, reason: 'json_entry_limit_exceeded', entries, maximumDepth, serializedBytes, maximumStringBytes };
      }
      serializedBytes += 2 + Math.max(0, children.length - 1);
      for (const [key, child] of children) {
        if (key !== null) serializedBytes += Buffer.byteLength(key, 'utf8') + 3;
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
    if (serializedBytes > limits.maxSerializedJsonBytes) {
      return { accepted: false, reason: 'serialized_json_byte_limit_exceeded', entries, maximumDepth, serializedBytes, maximumStringBytes };
    }
  }
  return { accepted: true, reason: null, entries, maximumDepth, serializedBytes, maximumStringBytes };
}

function collectExactClaims(value, rootPath = '$') {
  const claims = [];
  const visited = new WeakSet();
  const stack = [{ value, path: rootPath }];
  while (stack.length > 0) {
    const current = stack.pop();
    const entry = current.value;
    if (!entry || typeof entry !== 'object' || Buffer.isBuffer(entry) || entry instanceof URL) continue;
    if (visited.has(entry)) continue;
    visited.add(entry);
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => stack.push({ value: child, path: `${current.path}[${index}]` }));
      continue;
    }
    for (const [key, child] of Object.entries(entry)) {
      const normalizedKey = normalizeAliasKey(key);
      const childPath = `${current.path}.${key}`;
      if (EXACT_FALSE_CLAIM_FIELDS.has(normalizedKey) && child !== false) {
        claims.push({ path: childPath, field: key, reason: 'non_false_authority_value' });
      } else if (normalizedKey === 'proofauthority' || normalizedKey === 'evidenceauthority') {
        if (typeof child !== 'string' || !SUPPORT_AUTHORITIES.has(child.trim())) {
          claims.push({ path: childPath, field: key, reason: 'unsupported_authority_value' });
        }
      } else if (EXACT_STATUS_FIELDS.has(normalizedKey)) {
        const status = typeof child === 'string' ? child.trim().toLowerCase() : null;
        if (status && SUCCESS_STATE_VALUES.has(status)) {
          claims.push({ path: childPath, field: key, reason: 'success_state_claim' });
        }
      }
      stack.push({ value: child, path: childPath });
    }
  }
  return claims;
}

function requiredText(source, fields, fail, code) {
  const alias = aliasValue(source, fields, fail, `${code}_alias_conflict`);
  if (!alias.present) {
    fail(`${code}_missing`);
    return null;
  }
  if (alias.conflict || typeof alias.value !== 'string' || !alias.value.trim()) {
    if (!alias.conflict) fail(`${code}_invalid`);
    return null;
  }
  return alias.value.trim();
}

function requiredHash(source, fields, fail, code) {
  const value = requiredText(source, fields, fail, code);
  if (!value) return null;
  const normalized = normalizeHash(value);
  if (!normalized) fail(`${code}_invalid`);
  return normalized;
}

function requiredInteger(source, fields, fail, code, { allowZero = false } = {}) {
  const alias = aliasValue(source, fields, fail, `${code}_alias_conflict`);
  if (!alias.present) {
    fail(`${code}_missing`);
    return null;
  }
  const accepted = Number.isSafeInteger(alias.value) && (allowZero ? alias.value >= 0 : alias.value > 0);
  if (alias.conflict || !accepted) {
    if (!alias.conflict) fail(`${code}_invalid`);
    return null;
  }
  return alias.value;
}

function requiredObject(source, fields, fail, code) {
  const alias = aliasValue(source, fields, fail, `${code}_alias_conflict`);
  if (!alias.present) {
    fail(`${code}_missing`);
    return null;
  }
  if (alias.conflict || !objectOrNull(alias.value)) {
    if (!alias.conflict) fail(`${code}_invalid`);
    return null;
  }
  return alias.value;
}

function optionalObject(source, fields, fail, code) {
  const alias = aliasValue(source, fields, fail, `${code}_alias_conflict`);
  if (!alias.present) return null;
  if (alias.conflict || !objectOrNull(alias.value)) {
    if (!alias.conflict) fail(`${code}_invalid`);
    return null;
  }
  return alias.value;
}

function configuredLimit(options, key, snake, fail) {
  const alias = aliasValue(options, [key, snake], fail, `compute_oracle_limit_${snake}_alias_conflict`);
  const fallback = LIMIT_DEFAULTS[key];
  if (!alias.present) return fallback;
  if (!Number.isSafeInteger(alias.value) || alias.value <= 0) {
    fail(`compute_oracle_limit_${snake}_invalid`);
    return fallback;
  }
  if (alias.value > LIMIT_HARD_MAXIMUMS[key]) {
    fail(`compute_oracle_limit_${snake}_hard_maximum_exceeded`);
    return LIMIT_HARD_MAXIMUMS[key];
  }
  return alias.value;
}

function normalizeLimits(options, fail) {
  return Object.fromEntries(Object.keys(LIMIT_DEFAULTS).map((key) => {
    const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    return [key, configuredLimit(options, key, snake, fail)];
  }));
}

function normalizeMonotonicNs(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  return null;
}

function runtimeContextMaterial(context) {
  return {
    schemaVersion: COMPUTE_RUNTIME_CONTEXT_SCHEMA_VERSION,
    ...Object.fromEntries(RUNTIME_CONTEXT_FIELDS.map(({ camel }) => [camel, context?.[camel] ?? null])),
  };
}

function normalizeRuntimeContext(source, fail, prefix) {
  const context = objectOrNull(source);
  if (!context) {
    fail(`${prefix}_missing`);
    return null;
  }
  rejectUnknownFields(context, RUNTIME_CONTEXT_FIELDS_ALLOWED, fail, `${prefix}_unknown_fields`);
  const schemaVersion = requiredText(context, ['schemaVersion', 'schema_version'], fail, `${prefix}_schema_version`);
  if (schemaVersion && schemaVersion !== COMPUTE_RUNTIME_CONTEXT_SCHEMA_VERSION) {
    fail(`${prefix}_schema_version_invalid`);
  }
  const normalized = { schemaVersion: COMPUTE_RUNTIME_CONTEXT_SCHEMA_VERSION };
  for (const field of RUNTIME_CONTEXT_FIELDS) {
    const code = `${prefix}_${field.snake}`;
    if (field.kind === 'hash') {
      normalized[field.camel] = requiredHash(context, [field.camel, field.snake], fail, code);
    } else if (field.kind === 'text') {
      normalized[field.camel] = requiredText(context, [field.camel, field.snake], fail, code);
    } else {
      const alias = aliasValue(context, [field.camel, field.snake], fail, `${code}_alias_conflict`);
      if (!alias.present) {
        fail(`${code}_missing`);
        normalized[field.camel] = null;
      } else {
        normalized[field.camel] = normalizeMonotonicNs(alias.value);
        if (!normalized[field.camel]) fail(`${code}_invalid`);
      }
    }
  }
  if (
    normalized.dispatchTimestampMonotonicNs
    && normalized.timestampAfterDispatchMonotonicNs
    && BigInt(normalized.timestampAfterDispatchMonotonicNs)
      <= BigInt(normalized.dispatchTimestampMonotonicNs)
  ) {
    fail(`${prefix}_timestamp_not_after_dispatch`);
  }
  const declaredHash = requiredHash(context, ['contextHash', 'context_hash'], fail, `${prefix}_context_hash`);
  const contextHash = sha256Object(runtimeContextMaterial(normalized));
  if (declaredHash && declaredHash !== contextHash) fail(`${prefix}_context_hash_mismatch`);
  normalized.contextHash = contextHash;
  return normalized;
}

function compareRuntimeContexts(observed, expected, prefix, fail) {
  if (!observed || !expected) return false;
  let accepted = true;
  for (const field of RUNTIME_CONTEXT_FIELDS) {
    if (observed[field.camel] !== expected[field.camel]) {
      fail(`${prefix}_${field.snake}_mismatch`);
      accepted = false;
    }
  }
  if (observed.contextHash !== expected.contextHash) {
    fail(`${prefix}_context_hash_mismatch`);
    accepted = false;
  }
  return accepted;
}

function normalizeProvenance(source, fail) {
  if (!source) return null;
  rejectUnknownFields(source, PROVENANCE_FIELDS, fail, 'compute_oracle_provenance_unknown_fields');
  const schemaVersion = requiredText(source, ['schemaVersion', 'schema_version'], fail, 'compute_oracle_provenance_schema_version');
  if (schemaVersion && schemaVersion !== COMPUTE_ORACLE_PROVENANCE_SCHEMA_VERSION) {
    fail('compute_oracle_provenance_schema_version_invalid');
  }
  const producerId = requiredText(source, ['producerId', 'producer_id'], fail, 'compute_oracle_provenance_producer_id');
  if (producerId && !SAFE_ID_RE.test(producerId)) fail('compute_oracle_provenance_producer_id_invalid');
  const producerArtifactHash = requiredHash(
    source,
    ['producerArtifactHash', 'producer_artifact_hash'],
    fail,
    'compute_oracle_provenance_producer_artifact_hash',
  );
  const sessionNamespace = requiredText(
    source,
    ['sessionNamespace', 'session_namespace'],
    fail,
    'compute_oracle_provenance_session_namespace',
  );
  const refsAlias = aliasValue(source, ['evidenceRefs', 'evidence_refs'], fail, 'compute_oracle_provenance_evidence_refs_alias_conflict');
  let evidenceRefs = [];
  if (refsAlias.present) {
    if (!Array.isArray(refsAlias.value) || refsAlias.value.some((value) => !normalizeHash(value))) {
      fail('compute_oracle_provenance_evidence_refs_invalid');
    } else {
      evidenceRefs = [...new Set(refsAlias.value.map(normalizeHash))].sort();
    }
  }
  return {
    schemaVersion: COMPUTE_ORACLE_PROVENANCE_SCHEMA_VERSION,
    producerId,
    producerArtifactHash,
    sessionNamespace,
    evidenceRefs,
  };
}

function pathInsideOrSame(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

async function normalizeAllowedRoots(options, fail) {
  const values = [
    ...(Array.isArray(options.allowedRoots) ? options.allowedRoots : []),
    ...(Array.isArray(options.allowedArtifactRoots) ? options.allowedArtifactRoots : []),
    ...(Array.isArray(options.allowedCasRoots) ? options.allowedCasRoots : []),
    options.artifactRoot,
    options.casRoot,
  ].filter((value) => typeof value === 'string' && value.trim());
  if (values.length === 0) {
    fail('compute_oracle_artifact_allowed_roots_required');
    return [];
  }
  const roots = [];
  for (const value of values) {
    try {
      const canonical = await realpath(path.resolve(value));
      if (!roots.some((root) => samePath(root, canonical))) roots.push(canonical);
    } catch {
      fail('compute_oracle_artifact_allowed_root_unreadable');
    }
  }
  return roots;
}

function parsePathReference(value, baseDir) {
  if (value instanceof URL) {
    if (value.protocol !== 'file:') return { accepted: false, reason: 'unsupported_url_scheme' };
    try {
      return { accepted: true, path: path.resolve(fileURLToPath(value)) };
    } catch {
      return { accepted: false, reason: 'malformed_file_url' };
    }
  }
  if (typeof value !== 'string' || !value.trim()) return { accepted: false, reason: 'path_invalid' };
  const reference = value.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(reference) && !path.isAbsolute(reference)) {
      let url;
      try {
        url = new URL(reference);
      } catch {
        return { accepted: false, reason: 'malformed_file_url' };
      }
      if (url.protocol !== 'file:') return { accepted: false, reason: 'unsupported_url_scheme' };
      try {
        return { accepted: true, path: path.resolve(fileURLToPath(url)) };
      } catch {
        return { accepted: false, reason: 'malformed_file_url' };
      }
    }
    return { accepted: true, path: path.resolve(baseDir, reference) };
  } catch {
    return { accepted: false, reason: 'path_invalid' };
  }
}

function statIdentity(stats) {
  const device = String(stats.dev);
  return {
    device: device === '0' ? null : device,
    inode: String(stats.ino),
    size: String(stats.size),
    modifiedNs: String(stats.mtimeNs),
    changedNs: String(stats.ctimeNs),
    links: String(stats.nlink),
  };
}

function identityUsable(identity) {
  return Boolean(identity && identity.inode && identity.inode !== '0');
}

function identityMatches(left, right) {
  return identityUsable(left)
    && identityUsable(right)
    && (!left.device || !right.device || left.device === right.device)
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedNs === right.modifiedNs
    && left.changedNs === right.changedNs
    && left.links === right.links;
}

function lexicalRootFor(candidate, roots) {
  return roots.find((root) => pathInsideOrSame(candidate, root)) ?? null;
}

async function scanPathForLinks(candidate, root) {
  if (!root || !pathInsideOrSame(candidate, root)) {
    return { accepted: false, reason: 'lexical_path_outside_allowed_roots', checked: [] };
  }
  const relative = path.relative(root, candidate);
  const parts = relative ? relative.split(path.sep).filter(Boolean) : [];
  const checked = [];
  let current = root;
  try {
    const rootStats = await lstat(current, { bigint: true });
    checked.push(current);
    if (rootStats.isSymbolicLink()) {
      return { accepted: false, reason: 'allowed_root_is_link', checked };
    }
    for (const part of parts) {
      current = path.join(current, part);
      const stats = await lstat(current, { bigint: true });
      checked.push(current);
      if (stats.isSymbolicLink()) {
        return { accepted: false, reason: 'path_contains_link_or_reparse_point', checked };
      }
    }
    return { accepted: true, reason: null, checked };
  } catch {
    return { accepted: false, reason: 'path_component_unreadable', checked };
  }
}

async function linuxHandlePath(handle) {
  if (process.platform !== 'linux') return null;
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch {
    return null;
  }
}

async function openSafeHeldFile(reference, roots, baseDir, role, fail) {
  const parsed = parsePathReference(reference, baseDir);
  if (!parsed.accepted) {
    fail(`compute_oracle_${role}_${parsed.reason}`);
    return null;
  }
  const lexicalRoot = lexicalRootFor(parsed.path, roots);
  if (!lexicalRoot) {
    fail(`compute_oracle_${role}_lexical_path_outside_allowed_roots`);
    return null;
  }
  const linkScanBefore = await scanPathForLinks(parsed.path, lexicalRoot);
  if (!linkScanBefore.accepted) {
    fail(`compute_oracle_${role}_${linkScanBefore.reason}`);
    return null;
  }
  let canonicalBefore;
  try {
    canonicalBefore = await realpath(parsed.path);
  } catch {
    fail(`compute_oracle_${role}_path_unreadable`);
    return null;
  }
  const canonicalRoot = lexicalRootFor(canonicalBefore, roots);
  if (!canonicalRoot) {
    fail(`compute_oracle_${role}_canonical_path_outside_allowed_roots`);
    return null;
  }
  const noFollowSupported = process.platform === 'win32'
    || (Number.isInteger(fsConstants.O_NOFOLLOW) && fsConstants.O_NOFOLLOW !== 0);
  if (!noFollowSupported) {
    fail(`compute_oracle_${role}_safe_open_nofollow_unavailable`);
    return null;
  }
  const flags = process.platform === 'win32'
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle = null;
  try {
    handle = await open(canonicalBefore, flags);
    const handleStats = await handle.stat({ bigint: true });
    if (!handleStats.isFile()) {
      fail(`compute_oracle_${role}_not_regular_file`);
      await handle.close();
      return null;
    }
    const canonicalAfterOpen = await realpath(parsed.path);
    const pathStats = await statPath(canonicalAfterOpen, { bigint: true });
    const handleIdentity = statIdentity(handleStats);
    const pathIdentity = statIdentity(pathStats);
    if (!identityUsable(handleIdentity) || !identityUsable(pathIdentity)) {
      fail(`compute_oracle_${role}_safe_handle_identity_unavailable`);
      await handle.close();
      return null;
    }
    if (!identityMatches(handleIdentity, pathIdentity)) {
      fail(`compute_oracle_${role}_identity_mismatch_after_open`);
      await handle.close();
      return null;
    }
    const handlePath = await linuxHandlePath(handle);
    const finalResolvedPath = handlePath ?? canonicalAfterOpen;
    if (!roots.some((root) => pathInsideOrSame(finalResolvedPath, root))) {
      fail(`compute_oracle_${role}_opened_handle_path_outside_allowed_roots`);
      await handle.close();
      return null;
    }
    if (handlePath && !samePath(handlePath, canonicalAfterOpen)) {
      fail(`compute_oracle_${role}_opened_handle_path_mismatch`);
      await handle.close();
      return null;
    }
    const size = Number(handleStats.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      fail(`compute_oracle_${role}_byte_length_unsupported`);
      await handle.close();
      return null;
    }
    return {
      handle,
      role,
      requestedPath: parsed.path,
      canonicalPath: canonicalAfterOpen,
      lexicalRoot,
      canonicalRoot,
      finalResolvedPath,
      finalPathMethod: handlePath ? 'proc_fd_realpath' : 'realpath_bound_by_handle_identity',
      safeOpenMode: process.platform === 'win32'
        ? 'reparse_scan_plus_handle_identity'
        : 'o_nofollow_plus_handle_identity',
      size,
      preIdentity: handleIdentity,
      postIdentity: null,
      identityAccepted: false,
      linkScanBefore,
      linkScanAfter: null,
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    const reason = error?.code === 'ELOOP' ? 'safe_open_link_refused' : 'safe_open_failed';
    fail(`compute_oracle_${role}_${reason}`);
    return null;
  }
}

async function verifyHeldFileAfterRead(resource, roots, fail) {
  if (!resource?.handle) return false;
  let handleStats;
  try {
    handleStats = await resource.handle.stat({ bigint: true });
  } catch {
    fail(`compute_oracle_${resource.role}_held_file_stat_failed_after_read`);
    return false;
  }
  let canonicalAfterRead;
  try {
    canonicalAfterRead = await realpath(resource.requestedPath);
  } catch {
    fail(`compute_oracle_${resource.role}_path_disappeared_after_read`);
    return false;
  }
  const canonicalRoot = lexicalRootFor(canonicalAfterRead, roots);
  if (!canonicalRoot) {
    fail(`compute_oracle_${resource.role}_canonical_path_outside_allowed_roots_after_read`);
    return false;
  }
  const linkScanAfter = await scanPathForLinks(resource.requestedPath, resource.lexicalRoot);
  resource.linkScanAfter = linkScanAfter;
  if (!linkScanAfter.accepted) {
    fail(`compute_oracle_${resource.role}_${linkScanAfter.reason}_after_read`);
    return false;
  }
  let pathStats;
  try {
    pathStats = await statPath(canonicalAfterRead, { bigint: true });
  } catch {
    fail(`compute_oracle_${resource.role}_path_stat_failed_after_read`);
    return false;
  }
  const handleIdentity = statIdentity(handleStats);
  const pathIdentity = statIdentity(pathStats);
  resource.postIdentity = handleIdentity;
  const handlePath = await linuxHandlePath(resource.handle);
  const finalPath = handlePath ?? canonicalAfterRead;
  const finalPathAccepted = roots.some((root) => pathInsideOrSame(finalPath, root));
  const accepted = identityMatches(resource.preIdentity, handleIdentity)
    && identityMatches(handleIdentity, pathIdentity)
    && finalPathAccepted
    && (!handlePath || samePath(handlePath, canonicalAfterRead));
  resource.identityAccepted = accepted;
  resource.finalResolvedPath = finalPath;
  if (!accepted) fail(`compute_oracle_${resource.role}_identity_or_resolved_path_changed_during_read`);
  return accepted;
}

async function readBoundedFile(resource, maximumBytes, chunkBytes, roots, fail) {
  if (!resource) return null;
  if (resource.size > maximumBytes) {
    fail(`compute_oracle_${resource.role}_size_limit_exceeded`);
    return null;
  }
  const bytes = Buffer.alloc(resource.size);
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const requested = Math.min(chunkBytes, bytes.length - offset);
      const { bytesRead } = await resource.handle.read(bytes, offset, requested, offset);
      if (bytesRead <= 0) {
        fail(`compute_oracle_${resource.role}_unexpected_eof`);
        return null;
      }
      offset += bytesRead;
    }
  } catch {
    fail(`compute_oracle_${resource.role}_read_failed`);
    return null;
  }
  await verifyHeldFileAfterRead(resource, roots, fail);
  return bytes;
}

function parseBoundedJson(bytes, role, limits, fail) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`compute_oracle_${role}_utf8_invalid`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    fail(`compute_oracle_${role}_json_invalid`);
    return null;
  }
  if (!objectOrNull(parsed)) {
    fail(`compute_oracle_${role}_json_not_object`);
    return null;
  }
  const bounds = inspectSerializedBounds(parsed, limits);
  if (!bounds.accepted) {
    fail(`compute_oracle_${role}_${bounds.reason}`);
    return null;
  }
  return { parsed, bounds };
}

async function hashRawAndReadSlice(resource, slice, limits, roots, fail) {
  if (!resource) return null;
  if (resource.size > limits.maxRawReadbackBytes) {
    fail(`compute_oracle_${resource.role}_size_limit_exceeded`);
    return null;
  }
  if (
    !slice
    || !Number.isSafeInteger(slice.offset)
    || !Number.isSafeInteger(slice.length)
    || slice.offset < 0
    || slice.length <= 0
    || slice.offset + slice.length > resource.size
  ) {
    fail(`compute_oracle_${resource.role}_deterministic_slice_bounds_invalid`);
    return null;
  }
  if (slice.length > limits.maxDeterministicSliceBytes) {
    fail(`compute_oracle_${resource.role}_deterministic_slice_size_limit_exceeded`);
    return null;
  }
  const chunk = Buffer.allocUnsafe(Math.min(limits.hashChunkBytes, Math.max(1, resource.size)));
  const digest = createHash('sha256');
  let position = 0;
  try {
    while (position < resource.size) {
      const requested = Math.min(chunk.length, resource.size - position);
      const { bytesRead } = await resource.handle.read(chunk, 0, requested, position);
      if (bytesRead <= 0) {
        fail(`compute_oracle_${resource.role}_unexpected_eof`);
        return null;
      }
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } catch {
    fail(`compute_oracle_${resource.role}_stream_read_failed`);
    return null;
  }
  const sliceBytes = Buffer.alloc(slice.length);
  let slicePosition = 0;
  try {
    while (slicePosition < slice.length) {
      const { bytesRead } = await resource.handle.read(
        sliceBytes,
        slicePosition,
        slice.length - slicePosition,
        slice.offset + slicePosition,
      );
      if (bytesRead <= 0) {
        fail(`compute_oracle_${resource.role}_deterministic_slice_unexpected_eof`);
        return null;
      }
      slicePosition += bytesRead;
    }
  } catch {
    fail(`compute_oracle_${resource.role}_deterministic_slice_read_failed`);
    return null;
  }
  await verifyHeldFileAfterRead(resource, roots, fail);
  return {
    rawHash: `sha256:${digest.digest('hex')}`,
    sliceHash: sha256Bytes(sliceBytes),
    sliceBytes,
    byteLength: resource.size,
    streamed: true,
    hashChunkByteLength: chunk.length,
    sliceByteLength: sliceBytes.length,
  };
}

const CAS_LOCATOR_FIELDS = new Set([
  'schemaVersion',
  'artifactId',
  'contentHash',
  'artifactKind',
  'byteLength',
  'mediaType',
  'role',
  'producer',
  'producerSubsystem',
  'sessionNamespace',
  'artifactUri',
  'transport',
  'proofAuthority',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'storage',
  'sharedStorage',
  'shared_storage',
  'manifestHash',
]);
const CAS_PRODUCER_FIELDS = new Set(['name', 'kind']);
const CAS_TRANSPORT_FIELDS = new Set([
  'kind',
  'contentAddressed',
  'manifestOnly',
  'bytesEmbedded',
  'hotPathOptimized',
]);
const CAS_STORAGE_FIELDS = new Set(['kind', 'localPath', 'relativePath']);

function normalizeCasIdentity(locator, validation, descriptor, fail) {
  rejectUnknownFields(locator, CAS_LOCATOR_FIELDS, fail, `compute_oracle_${descriptor.role}_cas_unknown_fields`);
  if (locator.schemaVersion !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION) {
    fail(`compute_oracle_${descriptor.role}_cas_schema_invalid`);
  }
  if (locator.role !== descriptor.role) fail(`compute_oracle_${descriptor.role}_cas_role_mismatch`);
  if (locator.artifactKind !== descriptor.artifactKind) {
    fail(`compute_oracle_${descriptor.role}_cas_artifact_kind_mismatch`);
  }
  if (locator.mediaType !== descriptor.mediaType) {
    fail(`compute_oracle_${descriptor.role}_cas_media_type_mismatch`);
  }
  const manifestHash = normalizeHash(locator.manifestHash);
  if (!manifestHash) fail(`compute_oracle_${descriptor.role}_cas_manifest_hash_invalid`);
  if (manifestHash && validation?.manifestHash !== manifestHash) {
    fail(`compute_oracle_${descriptor.role}_cas_manifest_hash_mismatch`);
  }
  const producer = objectOrNull(locator.producer);
  if (!producer) {
    fail(`compute_oracle_${descriptor.role}_cas_producer_missing`);
  } else {
    rejectUnknownFields(producer, CAS_PRODUCER_FIELDS, fail, `compute_oracle_${descriptor.role}_cas_producer_unknown_fields`);
    if (typeof producer.name !== 'string' || !producer.name.trim()) {
      fail(`compute_oracle_${descriptor.role}_cas_producer_name_invalid`);
    }
    if (typeof producer.kind !== 'string' || !producer.kind.trim()) {
      fail(`compute_oracle_${descriptor.role}_cas_producer_kind_invalid`);
    }
  }
  const transport = objectOrNull(locator.transport);
  if (!transport) {
    fail(`compute_oracle_${descriptor.role}_cas_transport_missing`);
  } else {
    rejectUnknownFields(transport, CAS_TRANSPORT_FIELDS, fail, `compute_oracle_${descriptor.role}_cas_transport_unknown_fields`);
    if (
      transport.contentAddressed !== true
      || transport.manifestOnly !== true
      || transport.bytesEmbedded !== false
      || typeof transport.hotPathOptimized !== 'boolean'
    ) {
      fail(`compute_oracle_${descriptor.role}_cas_transport_flags_invalid`);
    }
  }
  const storage = objectOrNull(locator.storage) ?? {};
  rejectUnknownFields(storage, CAS_STORAGE_FIELDS, fail, `compute_oracle_${descriptor.role}_cas_storage_unknown_fields`);
  const contentHash = normalizeHash(locator.contentHash);
  const expectedRelativePath = contentHash ? casRelativePathForHash(contentHash) : null;
  if (storage.relativePath !== expectedRelativePath) {
    fail(`compute_oracle_${descriptor.role}_cas_relative_path_hash_mismatch`);
  }
  if (typeof locator.sessionNamespace !== 'string' || !locator.sessionNamespace.trim()) {
    fail(`compute_oracle_${descriptor.role}_cas_session_namespace_invalid`);
  }
  const identity = {
    schemaVersion: CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
    manifestHash,
    role: locator.role ?? null,
    artifactKind: locator.artifactKind ?? null,
    mediaType: locator.mediaType ?? null,
    artifactId: locator.artifactId ?? null,
    contentHash,
    byteLength: Number.isSafeInteger(locator.byteLength) ? locator.byteLength : null,
    producer: producer ? { name: producer.name ?? null, kind: producer.kind ?? null } : null,
    producerSubsystem: locator.producerSubsystem ?? null,
    sessionNamespace: locator.sessionNamespace ?? null,
    artifactUri: locator.artifactUri ?? null,
    transport: transport ? {
      kind: transport.kind ?? null,
      contentAddressed: transport.contentAddressed ?? null,
      manifestOnly: transport.manifestOnly ?? null,
      bytesEmbedded: transport.bytesEmbedded ?? null,
      hotPathOptimized: transport.hotPathOptimized ?? null,
    } : null,
    relativePath: storage.relativePath ?? null,
  };
  return { ...identity, identityHash: sha256Object(identity) };
}

function normalizeArtifactDeclaration(source, descriptor, fail) {
  const declaration = objectOrNull(source);
  if (!declaration) {
    fail(`compute_oracle_${descriptor.role}_declaration_missing`);
    return null;
  }
  rejectUnknownFields(
    declaration,
    ARTIFACT_DECLARATION_FIELDS,
    fail,
    `compute_oracle_${descriptor.role}_declaration_unknown_fields`,
  );
  const pathAlias = aliasValue(declaration, ['path'], fail, `compute_oracle_${descriptor.role}_path_alias_conflict`);
  const locatorAlias = aliasValue(
    declaration,
    ['casLocator', 'cas_locator'],
    fail,
    `compute_oracle_${descriptor.role}_cas_locator_alias_conflict`,
  );
  const locatorPathAlias = aliasValue(
    declaration,
    ['casLocatorManifestPath', 'cas_locator_manifest_path'],
    fail,
    `compute_oracle_${descriptor.role}_cas_locator_manifest_path_alias_conflict`,
  );
  const sourceCount = [pathAlias.present, locatorAlias.present, locatorPathAlias.present].filter(Boolean).length;
  if (sourceCount > 1) fail(`compute_oracle_${descriptor.role}_source_ambiguous`);
  const hashAlias = aliasValue(
    declaration,
    ['contentHash', 'content_hash'],
    fail,
    `compute_oracle_${descriptor.role}_content_hash_alias_conflict`,
  );
  const lengthAlias = aliasValue(
    declaration,
    ['byteLength', 'byte_length'],
    fail,
    `compute_oracle_${descriptor.role}_byte_length_alias_conflict`,
  );
  const declaredHash = hashAlias.present ? normalizeHash(hashAlias.value) : null;
  if (hashAlias.present && !declaredHash) fail(`compute_oracle_${descriptor.role}_content_hash_invalid`);
  const declaredLength = lengthAlias.present && Number.isSafeInteger(lengthAlias.value) && lengthAlias.value >= 0
    ? lengthAlias.value
    : null;
  if (lengthAlias.present && declaredLength === null) fail(`compute_oracle_${descriptor.role}_byte_length_invalid`);
  return {
    path: pathAlias.present ? pathAlias.value : null,
    locator: locatorAlias.present ? locatorAlias.value : null,
    locatorManifestPath: locatorPathAlias.present ? locatorPathAlias.value : null,
    sourceCount,
    declaredHash,
    declaredLength,
  };
}

async function loadLocatorFromManifest(reference, roots, baseDir, descriptor, limits, fail, resources) {
  const role = `${descriptor.role}_cas_locator_manifest`;
  const resource = await openSafeHeldFile(reference, roots, baseDir, role, fail);
  if (!resource) return { locator: null, fileEvidence: null };
  resources.push(resource);
  const bytes = await readBoundedFile(
    resource,
    limits.maxLocatorManifestBytes,
    limits.metadataChunkBytes,
    roots,
    fail,
  );
  if (!bytes) return { locator: null, fileEvidence: null };
  const parsed = parseBoundedJson(bytes, role, limits, fail)?.parsed ?? null;
  return {
    locator: parsed,
    fileEvidence: {
      contentHash: sha256Bytes(bytes),
      byteLength: bytes.length,
      identityAccepted: resource.identityAccepted,
      safeOpenMode: resource.safeOpenMode,
    },
  };
}

async function portableCasReference(locator, roots, descriptor, fail) {
  const storage = objectOrNull(locator.storage) ?? {};
  if (typeof storage.localPath === 'string' && storage.localPath.trim()) return storage.localPath.trim();
  const contentHash = normalizeHash(locator.contentHash);
  if (!contentHash) {
    fail(`compute_oracle_${descriptor.role}_cas_content_hash_invalid`);
    return null;
  }
  const relativePath = casRelativePathForHash(contentHash);
  if (storage.relativePath !== relativePath) {
    fail(`compute_oracle_${descriptor.role}_cas_relative_path_hash_mismatch`);
    return null;
  }
  for (const root of roots) {
    const candidate = path.join(root, ...relativePath.split('/'));
    try {
      await lstat(candidate);
      return candidate;
    } catch {
      // Try the next explicitly allowed CAS root.
    }
  }
  fail(`compute_oracle_${descriptor.role}_cas_relative_path_unreadable`);
  return null;
}

async function resolveArtifact({
  declarationSource,
  embeddedLocator,
  descriptor,
  roots,
  baseDir,
  limits,
  fail,
  resources,
}) {
  const localReasons = [];
  const roleFail = (code) => {
    if (code && !localReasons.includes(code)) localReasons.push(code);
    fail(code);
  };
  const declaration = normalizeArtifactDeclaration(declarationSource, descriptor, roleFail);
  if (!declaration) return { descriptor, declaration: null, resource: null, reasons: localReasons };
  if (embeddedLocator && (declaration.locator || declaration.locatorManifestPath)) {
    roleFail(`compute_oracle_${descriptor.role}_cas_locator_ambiguous`);
  }
  if (declaration.path && embeddedLocator) roleFail(`compute_oracle_${descriptor.role}_source_ambiguous`);
  let locator = declaration.locator ?? embeddedLocator ?? null;
  let locatorFileEvidence = null;
  if (declaration.locatorManifestPath) {
    const loaded = await loadLocatorFromManifest(
      declaration.locatorManifestPath,
      roots,
      baseDir,
      descriptor,
      limits,
      roleFail,
      resources,
    );
    locator = loaded.locator;
    locatorFileEvidence = loaded.fileEvidence;
  }
  const sourceKind = declaration.path ? 'direct_path' : 'cas_locator';
  if (!declaration.path && !locator) roleFail(`compute_oracle_${descriptor.role}_source_missing`);
  let casValidation = null;
  let casIdentity = null;
  let reference = declaration.path;
  if (locator) {
    const bounds = inspectSerializedBounds(locator, limits);
    if (!bounds.accepted) roleFail(`compute_oracle_${descriptor.role}_cas_${bounds.reason}`);
    const conflicts = collectAliasConflicts(locator, `$.${descriptor.role}.casLocator`);
    if (conflicts.length > 0) roleFail(`compute_oracle_${descriptor.role}_cas_alias_conflict`);
    const claims = collectExactClaims(locator, `$.${descriptor.role}.casLocator`);
    if (claims.length > 0) roleFail(`compute_oracle_${descriptor.role}_cas_claims_authority`);
    try {
      casValidation = await validateArtifactCasManifest(locator, {
        allowedRoots: roots,
        artifactRoot: roots[0] ?? null,
        requireReadableBytes: false,
      });
    } catch {
      roleFail(`compute_oracle_${descriptor.role}_cas_validation_exception`);
    }
    if (casValidation?.accepted !== true) roleFail(`compute_oracle_${descriptor.role}_cas_locator_invalid`);
    casIdentity = normalizeCasIdentity(locator, casValidation, descriptor, roleFail);
    reference = await portableCasReference(locator, roots, descriptor, roleFail);
  }
  let resource = null;
  if (reference && localReasons.length === 0) {
    resource = await openSafeHeldFile(reference, roots, baseDir, descriptor.role, roleFail);
    if (resource) resources.push(resource);
  }
  return {
    descriptor,
    declaration,
    resource,
    locator,
    locatorFileEvidence,
    casValidation,
    casIdentity,
    sourceKind,
    reasons: localReasons,
    roleFail,
    contentHash: null,
    byteLength: resource?.size ?? null,
    accepted: false,
  };
}

function finalizeArtifact(resolved, actualHash) {
  if (!resolved) return null;
  const { declaration, descriptor, locator, resource, roleFail } = resolved;
  resolved.contentHash = actualHash;
  resolved.byteLength = resource?.size ?? null;
  if (resolved.sourceKind === 'direct_path') {
    if (!declaration?.declaredHash) roleFail(`compute_oracle_${descriptor.role}_content_hash_missing`);
    if (declaration?.declaredHash && declaration.declaredHash !== actualHash) {
      roleFail(`compute_oracle_${descriptor.role}_content_hash_mismatch`);
    }
    if (declaration?.declaredLength === null) roleFail(`compute_oracle_${descriptor.role}_byte_length_missing`);
    if (declaration?.declaredLength !== null && declaration.declaredLength !== resource?.size) {
      roleFail(`compute_oracle_${descriptor.role}_byte_length_mismatch`);
    }
  } else if (locator) {
    if (normalizeHash(locator.contentHash) !== actualHash) {
      roleFail(`compute_oracle_${descriptor.role}_cas_readable_hash_mismatch`);
    }
    if (!Number.isSafeInteger(locator.byteLength) || locator.byteLength !== resource?.size) {
      roleFail(`compute_oracle_${descriptor.role}_cas_readable_byte_length_mismatch`);
    }
    if (declaration?.declaredHash && declaration.declaredHash !== actualHash) {
      roleFail(`compute_oracle_${descriptor.role}_declared_content_hash_mismatch`);
    }
    if (declaration?.declaredLength !== null && declaration.declaredLength !== resource?.size) {
      roleFail(`compute_oracle_${descriptor.role}_declared_byte_length_mismatch`);
    }
  }
  resolved.accepted = resolved.reasons.length === 0 && resource?.identityAccepted === true;
  return resolved;
}

function artifactEvidence(resolved) {
  if (!resolved) return null;
  const identity = resolved.resource ? {
    pre: resolved.resource.preIdentity,
    post: resolved.resource.postIdentity,
    accepted: resolved.resource.identityAccepted,
    safeOpenMode: resolved.resource.safeOpenMode,
    finalPathMethod: resolved.resource.finalPathMethod,
    finalResolvedPath: resolved.resource.finalResolvedPath,
  } : null;
  return {
    role: resolved.descriptor.role,
    accepted: resolved.accepted,
    sourceKind: resolved.sourceKind,
    contentHash: resolved.contentHash,
    byteLength: resolved.byteLength,
    identity,
    casIdentity: resolved.casIdentity,
    casValidation: resolved.casValidation,
    locatorFileEvidence: resolved.locatorFileEvidence,
    reasons: resolved.reasons,
    failedGates: resolved.reasons.map((code) => ({ code })),
  };
}

function codecContractMaterial(contract) {
  return {
    schemaVersion: COMPUTE_CODEC_CONTRACT_SCHEMA_VERSION,
    dtypeName: contract?.dtypeName ?? null,
    byteWidth: contract?.byteWidth ?? null,
    byteOrder: contract?.byteOrder ?? null,
    layoutKind: contract?.layoutKind ?? null,
    executableHash: contract?.executableHash ?? null,
    artifactId: contract?.artifactId ?? null,
  };
}

function normalizeCodecContract(source, fail, prefix) {
  const contract = objectOrNull(source);
  if (!contract) {
    fail(`${prefix}_missing`);
    return null;
  }
  rejectUnknownFields(contract, CODEC_CONTRACT_FIELDS, fail, `${prefix}_unknown_fields`);
  const schemaVersion = requiredText(contract, ['schemaVersion', 'schema_version'], fail, `${prefix}_schema_version`);
  if (schemaVersion && schemaVersion !== COMPUTE_CODEC_CONTRACT_SCHEMA_VERSION) {
    fail(`${prefix}_schema_version_invalid`);
  }
  const dtypeName = requiredText(contract, ['dtypeName', 'dtype_name'], fail, `${prefix}_dtype_name`);
  if (dtypeName && dtypeName !== dtypeName.toLowerCase()) fail(`${prefix}_dtype_name_not_canonical`);
  const byteWidth = requiredInteger(contract, ['byteWidth', 'byte_width'], fail, `${prefix}_byte_width`);
  const byteOrder = requiredText(contract, ['byteOrder', 'byte_order'], fail, `${prefix}_byte_order`);
  if (byteOrder && !['little_endian', 'big_endian', 'not_applicable'].includes(byteOrder)) {
    fail(`${prefix}_byte_order_invalid`);
  }
  const layoutKind = requiredText(contract, ['layoutKind', 'layout_kind'], fail, `${prefix}_layout_kind`);
  if (layoutKind && layoutKind !== 'packed') fail(`${prefix}_layout_kind_invalid`);
  const executableHash = requiredHash(
    contract,
    ['executableHash', 'executable_hash'],
    fail,
    `${prefix}_executable_hash`,
  );
  const artifactId = requiredText(contract, ['artifactId', 'artifact_id'], fail, `${prefix}_artifact_id`);
  if (executableHash && artifactId !== `artifact:${executableHash}`) {
    fail(`${prefix}_artifact_id_hash_mismatch`);
  }
  const normalized = {
    schemaVersion: COMPUTE_CODEC_CONTRACT_SCHEMA_VERSION,
    dtypeName,
    byteWidth,
    byteOrder,
    layoutKind,
    executableHash,
    artifactId,
  };
  const declaredHash = requiredHash(contract, ['contractHash', 'contract_hash'], fail, `${prefix}_contract_hash`);
  const contractHash = sha256Object(codecContractMaterial(normalized));
  if (declaredHash && declaredHash !== contractHash) fail(`${prefix}_contract_hash_mismatch`);
  normalized.contractHash = contractHash;
  return normalized;
}

function normalizeTrustedCodecContracts(options, limits, fail) {
  const alias = aliasValue(
    options,
    ['trustedCodecContracts', 'trusted_codec_contracts'],
    fail,
    'compute_oracle_trusted_codec_contracts_alias_conflict',
  );
  if (!alias.present) return new Map();
  if (!Array.isArray(alias.value)) {
    fail('compute_oracle_trusted_codec_contracts_invalid');
    return new Map();
  }
  const trusted = new Map();
  alias.value.forEach((entry, index) => {
    const bounds = inspectSerializedBounds(entry, limits);
    if (!bounds.accepted) {
      fail(`compute_oracle_trusted_codec_contract_${bounds.reason}`);
      return;
    }
    const contract = normalizeCodecContract(
      entry,
      fail,
      `compute_oracle_trusted_codec_contract_${index}`,
    );
    if (contract) trusted.set(contract.contractHash, contract);
  });
  return trusted;
}

function normalizeSlice(source, rawByteLength, limits, fail, prefix) {
  const slice = objectOrNull(source);
  if (!slice) {
    fail(`${prefix}_missing`);
    return null;
  }
  rejectUnknownFields(slice, SLICE_FIELDS, fail, `${prefix}_unknown_fields`);
  const offset = requiredInteger(
    slice,
    ['offset', 'byteOffset', 'byte_offset'],
    fail,
    `${prefix}_offset`,
    { allowZero: true },
  );
  const length = requiredInteger(
    slice,
    ['length', 'byteLength', 'byte_length'],
    fail,
    `${prefix}_length`,
  );
  const hash = requiredHash(slice, ['hash', 'sliceHash', 'slice_hash'], fail, `${prefix}_hash`);
  if (
    offset !== null
    && length !== null
    && (!Number.isSafeInteger(offset + length) || offset + length > rawByteLength)
  ) {
    fail(`${prefix}_out_of_bounds`);
  }
  if (length !== null && length > limits.maxDeterministicSliceBytes) {
    fail(`${prefix}_size_limit_exceeded`);
  }
  return { offset, length, hash };
}

function schemaDerivationMaterial(readbackSchema) {
  return {
    schemaVersion: COMPUTE_READBACK_SCHEMA_VERSION,
    dtype: {
      name: readbackSchema?.dtype?.name ?? null,
      byteWidth: readbackSchema?.dtype?.byteWidth ?? null,
      codecContractHash: readbackSchema?.dtype?.codecContract?.contractHash ?? null,
    },
    shape: readbackSchema?.shape ?? null,
    elementCount: readbackSchema?.elementCount ?? null,
    byteLength: readbackSchema?.byteLength ?? null,
    byteOrder: readbackSchema?.byteOrder ?? null,
    layout: readbackSchema?.layout ?? null,
    rawReadbackHash: readbackSchema?.rawReadbackHash ?? null,
    deterministicSlice: readbackSchema?.deterministicSlice ?? null,
    runtimeContextHash: readbackSchema?.runtimeContext?.contextHash ?? null,
  };
}

function normalizeReadbackSchema(source, rawByteLength, limits, trustedCodecs, fail, prefix) {
  const schema = objectOrNull(source);
  if (!schema) {
    fail(`${prefix}_missing`);
    return null;
  }
  rejectUnknownFields(schema, READBACK_SCHEMA_FIELDS, fail, `${prefix}_unknown_fields`);
  const schemaVersion = requiredText(schema, ['schemaVersion', 'schema_version'], fail, `${prefix}_schema_version`);
  if (schemaVersion && schemaVersion !== COMPUTE_READBACK_SCHEMA_VERSION) {
    fail(`${prefix}_schema_version_invalid`);
  }
  const dtypeSource = requiredObject(schema, ['dtype'], fail, `${prefix}_dtype`);
  let dtype = null;
  if (dtypeSource) {
    rejectUnknownFields(dtypeSource, DTYPE_FIELDS, fail, `${prefix}_dtype_unknown_fields`);
    const name = requiredText(dtypeSource, ['name'], fail, `${prefix}_dtype_name`);
    if (name && name !== name.toLowerCase()) fail(`${prefix}_dtype_name_not_canonical`);
    const byteWidth = requiredInteger(
      dtypeSource,
      ['byteWidth', 'byte_width'],
      fail,
      `${prefix}_dtype_byte_width`,
    );
    const codecSource = optionalObject(
      dtypeSource,
      ['codecContract', 'codec_contract'],
      fail,
      `${prefix}_dtype_codec_contract`,
    );
    const knownWidth = name ? CANONICAL_DTYPE_WIDTHS.get(name) ?? null : null;
    let codecContract = null;
    if (knownWidth !== null) {
      if (byteWidth !== null && byteWidth !== knownWidth) fail(`${prefix}_dtype_width_registry_mismatch`);
      if (codecSource) fail(`${prefix}_canonical_dtype_codec_contract_forbidden`);
    } else {
      if (!codecSource) {
        fail(`${prefix}_opaque_dtype_codec_contract_required`);
      } else {
        codecContract = normalizeCodecContract(codecSource, fail, `${prefix}_dtype_codec_contract`);
        if (codecContract) {
          if (codecContract.dtypeName !== name) fail(`${prefix}_dtype_codec_name_mismatch`);
          if (codecContract.byteWidth !== byteWidth) fail(`${prefix}_dtype_codec_width_mismatch`);
          if (!trustedCodecs.has(codecContract.contractHash)) {
            fail(`${prefix}_dtype_codec_contract_not_trusted`);
          } else if (
            stableJson(codecContractMaterial(trustedCodecs.get(codecContract.contractHash)))
            !== stableJson(codecContractMaterial(codecContract))
          ) {
            fail(`${prefix}_dtype_codec_contract_trust_mismatch`);
          }
        }
      }
    }
    dtype = { name, byteWidth, codecContract };
  }
  const shapeAlias = aliasValue(schema, ['shape'], fail, `${prefix}_shape_alias_conflict`);
  let shape = null;
  if (!shapeAlias.present) {
    fail(`${prefix}_shape_missing`);
  } else if (
    !Array.isArray(shapeAlias.value)
    || shapeAlias.value.some((dimension) => !Number.isSafeInteger(dimension) || dimension <= 0)
  ) {
    fail(`${prefix}_shape_invalid`);
  } else {
    shape = [...shapeAlias.value];
  }
  const elementCount = requiredInteger(
    schema,
    ['elementCount', 'element_count'],
    fail,
    `${prefix}_element_count`,
  );
  const byteLength = requiredInteger(
    schema,
    ['byteLength', 'byte_length'],
    fail,
    `${prefix}_byte_length`,
  );
  const byteOrder = requiredText(schema, ['byteOrder', 'byte_order'], fail, `${prefix}_byte_order`);
  if (dtype?.byteWidth === 1 && byteOrder !== 'not_applicable') {
    fail(`${prefix}_single_byte_dtype_byte_order_invalid`);
  }
  if (dtype?.byteWidth > 1 && !['little_endian', 'big_endian'].includes(byteOrder)) {
    fail(`${prefix}_multi_byte_dtype_byte_order_invalid`);
  }
  if (dtype?.codecContract && dtype.codecContract.byteOrder !== byteOrder) {
    fail(`${prefix}_dtype_codec_byte_order_mismatch`);
  }
  const layoutSource = requiredObject(schema, ['layout'], fail, `${prefix}_layout`);
  let layout = null;
  if (layoutSource) {
    rejectUnknownFields(layoutSource, LAYOUT_FIELDS, fail, `${prefix}_layout_unknown_fields`);
    const layoutSchema = requiredText(
      layoutSource,
      ['schemaVersion', 'schema_version'],
      fail,
      `${prefix}_layout_schema_version`,
    );
    if (layoutSchema && layoutSchema !== COMPUTE_PACKED_LAYOUT_SCHEMA_VERSION) {
      fail(`${prefix}_layout_schema_version_invalid`);
    }
    const kind = requiredText(layoutSource, ['kind'], fail, `${prefix}_layout_kind`);
    if (kind && kind !== 'packed') fail(`${prefix}_layout_not_packed`);
    const stride = requiredInteger(
      layoutSource,
      ['elementStrideBytes', 'element_stride_bytes'],
      fail,
      `${prefix}_layout_element_stride_bytes`,
    );
    const padding = requiredInteger(
      layoutSource,
      ['paddingBytes', 'padding_bytes'],
      fail,
      `${prefix}_layout_padding_bytes`,
      { allowZero: true },
    );
    const contiguousAlias = aliasValue(
      layoutSource,
      ['contiguous'],
      fail,
      `${prefix}_layout_contiguous_alias_conflict`,
    );
    if (!contiguousAlias.present || contiguousAlias.value !== true) {
      fail(`${prefix}_layout_contiguous_required`);
    }
    if (dtype?.byteWidth !== null && stride !== dtype?.byteWidth) fail(`${prefix}_layout_stride_mismatch`);
    if (padding !== 0) fail(`${prefix}_layout_padding_not_zero`);
    layout = {
      schemaVersion: COMPUTE_PACKED_LAYOUT_SCHEMA_VERSION,
      kind: 'packed',
      elementStrideBytes: stride,
      paddingBytes: padding,
      contiguous: true,
    };
  }
  let shapeElementCount = null;
  if (shape) {
    shapeElementCount = 1;
    for (const dimension of shape) {
      shapeElementCount *= dimension;
      if (!Number.isSafeInteger(shapeElementCount)) {
        fail(`${prefix}_shape_element_count_overflow`);
        shapeElementCount = null;
        break;
      }
    }
  }
  if (shapeElementCount !== null && elementCount !== shapeElementCount) {
    fail(`${prefix}_shape_element_count_mismatch`);
  }
  if (elementCount !== null && dtype?.byteWidth !== null) {
    const packedLength = elementCount * dtype.byteWidth;
    if (!Number.isSafeInteger(packedLength)) {
      fail(`${prefix}_packed_byte_length_overflow`);
    } else if (packedLength !== byteLength) {
      fail(`${prefix}_packed_byte_length_mismatch`);
    }
  }
  if (byteLength !== rawByteLength) fail(`${prefix}_raw_byte_length_mismatch`);
  const rawReadbackHash = requiredHash(
    schema,
    ['rawReadbackHash', 'raw_readback_hash'],
    fail,
    `${prefix}_raw_readback_hash`,
  );
  const sliceSource = requiredObject(
    schema,
    ['deterministicSlice', 'deterministic_slice'],
    fail,
    `${prefix}_deterministic_slice`,
  );
  const deterministicSlice = normalizeSlice(
    sliceSource,
    rawByteLength,
    limits,
    fail,
    `${prefix}_deterministic_slice`,
  );
  const runtimeSource = requiredObject(
    schema,
    ['runtimeContext', 'runtime_context'],
    fail,
    `${prefix}_runtime_context`,
  );
  const runtimeContext = normalizeRuntimeContext(runtimeSource, fail, `${prefix}_runtime_context`);
  const proofCardBinding = requiredObject(
    schema,
    ['proofCardBinding', 'proof_card_binding'],
    fail,
    `${prefix}_proof_card_binding`,
  );
  const normalized = {
    schemaVersion: COMPUTE_READBACK_SCHEMA_VERSION,
    dtype,
    shape,
    elementCount,
    byteLength,
    byteOrder,
    layout,
    rawReadbackHash,
    deterministicSlice,
    runtimeContext,
    proofCardBinding,
  };
  normalized.schemaDerivationHash = sha256Object(schemaDerivationMaterial(normalized));
  return normalized;
}

let rendererIdentityPromise = null;

async function computeRendererIdentity() {
  const moduleBytes = await readFile(fileURLToPath(import.meta.url));
  const material = {
    schemaVersion: COMPUTE_RENDERER_IDENTITY_SCHEMA_VERSION,
    rendererKind: COMPUTE_RENDERER_KIND,
    rendererContractVersion: COMPUTE_RENDERER_CONTRACT_VERSION,
    moduleHash: sha256Bytes(moduleBytes),
    sharpVersion: String(sharp.versions?.sharp ?? ''),
    vipsVersion: String(sharp.versions?.vips ?? ''),
  };
  const executableHash = sha256Object(material);
  return {
    ...material,
    executableHash,
    artifactId: `artifact:${executableHash}`,
  };
}

export async function deterministicComputeProofCardRendererIdentity() {
  rendererIdentityPromise ??= computeRendererIdentity();
  return structuredClone(await rendererIdentityPromise);
}

function cardDerivationMaterial(schemaHash, rawHash, sliceHash, rendererIdentity) {
  return {
    schemaVersion: COMPUTE_RENDERER_CONTRACT_VERSION,
    schemaDerivationHash: schemaHash,
    rawReadbackHash: rawHash,
    deterministicSliceHash: sliceHash,
    rendererExecutableHash: rendererIdentity.executableHash,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    channels: CARD_CHANNELS,
  };
}

function proofCardBindingMaterial(binding) {
  return {
    schemaVersion: COMPUTE_PROOF_CARD_BINDING_SCHEMA_VERSION,
    rawReadbackHash: binding?.rawReadbackHash ?? null,
    deterministicSliceHash: binding?.deterministicSliceHash ?? null,
    schemaDerivationHash: binding?.schemaDerivationHash ?? null,
    renderedCardHash: binding?.renderedCardHash ?? null,
    rendererExecutable: binding?.rendererExecutable ?? null,
    derivationHash: binding?.derivationHash ?? null,
  };
}

function buildCardPixels(descriptor, sliceBytes) {
  const descriptorBytes = Buffer.from(stableJson(descriptor), 'utf8');
  const digest = createHash('sha256').update(descriptorBytes).update(sliceBytes).digest();
  const pixels = Buffer.alloc(CARD_WIDTH * CARD_HEIGHT * CARD_CHANNELS);
  for (let y = 0; y < CARD_HEIGHT; y += 1) {
    for (let x = 0; x < CARD_WIDTH; x += 1) {
      const pixel = y * CARD_WIDTH + x;
      const offset = pixel * CARD_CHANNELS;
      const raw = sliceBytes[(pixel * 13 + y * 7) % sliceBytes.length];
      const seedA = digest[(x + y * 3) % digest.length];
      const seedB = digest[(x * 5 + y) % digest.length];
      const header = y < 18;
      pixels[offset] = header ? seedA : (raw + seedA + x) % 256;
      pixels[offset + 1] = header ? seedB : (raw * 3 + seedB + y) % 256;
      pixels[offset + 2] = header ? (seedA ^ seedB) : (raw ^ seedA ^ ((x + y) % 256));
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

export async function renderDeterministicComputeProofCard({
  readbackSchema,
  deterministicSliceBytes,
} = {}) {
  const schema = objectOrNull(readbackSchema);
  const sliceBytes = Buffer.isBuffer(deterministicSliceBytes)
    ? deterministicSliceBytes
    : Buffer.from(deterministicSliceBytes ?? []);
  if (!schema || sliceBytes.length === 0) throw new Error('compute_proof_card_derivation_input_invalid');
  const sliceHash = sha256Bytes(sliceBytes);
  if (schema.deterministicSlice?.hash !== sliceHash) {
    throw new Error('compute_proof_card_derivation_slice_hash_mismatch');
  }
  const schemaHash = sha256Object(schemaDerivationMaterial(schema));
  const rendererExecutable = await deterministicComputeProofCardRendererIdentity();
  const descriptor = cardDerivationMaterial(
    schemaHash,
    schema.rawReadbackHash,
    sliceHash,
    rendererExecutable,
  );
  const derivationHash = sha256Object(descriptor);
  const pixels = buildCardPixels(descriptor, sliceBytes);
  const bytes = await sharp(pixels, {
    raw: { width: CARD_WIDTH, height: CARD_HEIGHT, channels: CARD_CHANNELS },
  }).png({
    adaptiveFiltering: false,
    compressionLevel: 9,
    force: true,
    palette: false,
  }).toBuffer();
  const renderedCardHash = sha256Bytes(bytes);
  const binding = {
    schemaVersion: COMPUTE_PROOF_CARD_BINDING_SCHEMA_VERSION,
    rawReadbackHash: schema.rawReadbackHash,
    deterministicSliceHash: sliceHash,
    schemaDerivationHash: schemaHash,
    renderedCardHash,
    rendererExecutable,
    derivationHash,
  };
  binding.bindingHash = sha256Object(proofCardBindingMaterial(binding));
  return {
    bytes,
    contentHash: renderedCardHash,
    binding,
    rendererExecutable,
    schemaDerivationHash: schemaHash,
    derivationHash,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  };
}

function normalizeRendererIdentity(source, fail, prefix) {
  const renderer = objectOrNull(source);
  if (!renderer) {
    fail(`${prefix}_missing`);
    return null;
  }
  rejectUnknownFields(renderer, RENDERER_IDENTITY_FIELDS, fail, `${prefix}_unknown_fields`);
  const normalized = {
    schemaVersion: requiredText(renderer, ['schemaVersion', 'schema_version'], fail, `${prefix}_schema_version`),
    rendererKind: requiredText(renderer, ['rendererKind', 'renderer_kind'], fail, `${prefix}_renderer_kind`),
    rendererContractVersion: requiredText(
      renderer,
      ['rendererContractVersion', 'renderer_contract_version'],
      fail,
      `${prefix}_renderer_contract_version`,
    ),
    moduleHash: requiredHash(renderer, ['moduleHash', 'module_hash'], fail, `${prefix}_module_hash`),
    sharpVersion: requiredText(renderer, ['sharpVersion', 'sharp_version'], fail, `${prefix}_sharp_version`),
    vipsVersion: requiredText(renderer, ['vipsVersion', 'vips_version'], fail, `${prefix}_vips_version`),
    executableHash: requiredHash(
      renderer,
      ['executableHash', 'executable_hash'],
      fail,
      `${prefix}_executable_hash`,
    ),
    artifactId: requiredText(renderer, ['artifactId', 'artifact_id'], fail, `${prefix}_artifact_id`),
  };
  if (normalized.schemaVersion !== COMPUTE_RENDERER_IDENTITY_SCHEMA_VERSION) {
    fail(`${prefix}_schema_version_invalid`);
  }
  if (normalized.rendererKind !== COMPUTE_RENDERER_KIND) fail(`${prefix}_renderer_kind_invalid`);
  if (normalized.rendererContractVersion !== COMPUTE_RENDERER_CONTRACT_VERSION) {
    fail(`${prefix}_renderer_contract_version_invalid`);
  }
  const identityMaterial = {
    schemaVersion: normalized.schemaVersion,
    rendererKind: normalized.rendererKind,
    rendererContractVersion: normalized.rendererContractVersion,
    moduleHash: normalized.moduleHash,
    sharpVersion: normalized.sharpVersion,
    vipsVersion: normalized.vipsVersion,
  };
  const recomputedHash = sha256Object(identityMaterial);
  if (normalized.executableHash !== recomputedHash) fail(`${prefix}_executable_hash_mismatch`);
  if (normalized.artifactId !== `artifact:${recomputedHash}`) fail(`${prefix}_artifact_id_hash_mismatch`);
  return normalized;
}

async function decodeProofCard(bytes, limits, fail, prefix) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < signature.length || !bytes.subarray(0, signature.length).equals(signature)) {
    fail(`${prefix}_png_signature_invalid`);
  }
  try {
    const decoded = await sharp(bytes, {
      failOn: 'error',
      limitInputPixels: limits.maxProofCardPixels,
    }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = decoded.info;
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
      fail(`${prefix}_dimensions_invalid`);
      return null;
    }
    const pixelCount = width * height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > limits.maxProofCardPixels) {
      fail(`${prefix}_pixel_limit_exceeded`);
      return null;
    }
    let opaquePixels = 0;
    let visiblePixels = 0;
    const colors = new Set();
    for (let offset = 0; offset < decoded.data.length; offset += channels) {
      const r = decoded.data[offset] ?? 0;
      const g = decoded.data[offset + 1] ?? 0;
      const b = decoded.data[offset + 2] ?? 0;
      const a = decoded.data[offset + 3] ?? 255;
      if (a >= 224) opaquePixels += 1;
      if (a >= 64 && (r > 3 || g > 3 || b > 3)) visiblePixels += 1;
      if (colors.size <= 1024 && a >= 64) colors.add(`${r},${g},${b},${a}`);
    }
    const visibleRatio = pixelCount > 0 ? visiblePixels / pixelCount : 0;
    const opaqueRatio = pixelCount > 0 ? opaquePixels / pixelCount : 0;
    if (visiblePixels < Math.max(64, Math.ceil(pixelCount * 0.01))) {
      fail(`${prefix}_visible_pixel_threshold_failed`);
    }
    if (opaqueRatio < 0.5) fail(`${prefix}_almost_transparent`);
    if (colors.size < 8) fail(`${prefix}_uniform_or_low_information`);
    return {
      decoded: true,
      width,
      height,
      channels,
      pixelCount,
      visiblePixels,
      visibleRatio,
      opaquePixels,
      opaqueRatio,
      uniqueColorCount: colors.size,
      supportOnly: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    };
  } catch (error) {
    fail(`${prefix}_decode_failed`);
    return {
      decoded: false,
      decodeError: error?.message ? String(error.message) : String(error),
      supportOnly: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    };
  }
}

async function verifyProofCard({ schema, sliceBytes, suppliedBytes, limits, fail, prefix }) {
  const suppliedBinding = objectOrNull(schema?.proofCardBinding);
  if (!suppliedBinding) {
    fail(`${prefix}_binding_missing`);
    return null;
  }
  rejectUnknownFields(suppliedBinding, CARD_BINDING_FIELDS, fail, `${prefix}_binding_unknown_fields`);
  const rendererSource = requiredObject(
    suppliedBinding,
    ['rendererExecutable', 'renderer_executable'],
    fail,
    `${prefix}_binding_renderer_executable`,
  );
  const suppliedRenderer = normalizeRendererIdentity(rendererSource, fail, `${prefix}_renderer_identity`);
  let expected;
  try {
    expected = await renderDeterministicComputeProofCard({
      readbackSchema: schema,
      deterministicSliceBytes: sliceBytes,
    });
  } catch {
    fail(`${prefix}_deterministic_derivation_failed`);
    return {
      accepted: false,
      suppliedCardHash: sha256Bytes(suppliedBytes),
      expectedCardHash: null,
      bindingHash: null,
      derivationHash: null,
      rendererExecutable: null,
      visual: await decodeProofCard(suppliedBytes, limits, fail, prefix),
      supportOnly: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    };
  }
  const expectedRenderer = expected.rendererExecutable;
  if (suppliedRenderer && stableJson(suppliedRenderer) !== stableJson(expectedRenderer)) {
    fail(`${prefix}_renderer_identity_not_trusted`);
  }
  const declared = {
    schemaVersion: requiredText(
      suppliedBinding,
      ['schemaVersion', 'schema_version'],
      fail,
      `${prefix}_binding_schema_version`,
    ),
    rawReadbackHash: requiredHash(
      suppliedBinding,
      ['rawReadbackHash', 'raw_readback_hash'],
      fail,
      `${prefix}_binding_raw_readback_hash`,
    ),
    deterministicSliceHash: requiredHash(
      suppliedBinding,
      ['deterministicSliceHash', 'deterministic_slice_hash'],
      fail,
      `${prefix}_binding_deterministic_slice_hash`,
    ),
    schemaDerivationHash: requiredHash(
      suppliedBinding,
      ['schemaDerivationHash', 'schema_derivation_hash'],
      fail,
      `${prefix}_binding_schema_derivation_hash`,
    ),
    renderedCardHash: requiredHash(
      suppliedBinding,
      ['renderedCardHash', 'rendered_card_hash'],
      fail,
      `${prefix}_binding_rendered_card_hash`,
    ),
    rendererExecutable: suppliedRenderer,
    derivationHash: requiredHash(
      suppliedBinding,
      ['derivationHash', 'derivation_hash'],
      fail,
      `${prefix}_binding_derivation_hash`,
    ),
  };
  const declaredBindingHash = requiredHash(
    suppliedBinding,
    ['bindingHash', 'binding_hash'],
    fail,
    `${prefix}_binding_hash`,
  );
  const recomputedBindingHash = sha256Object(proofCardBindingMaterial(declared));
  if (declaredBindingHash && declaredBindingHash !== recomputedBindingHash) {
    fail(`${prefix}_binding_hash_mismatch`);
  }
  for (const field of [
    'schemaVersion',
    'rawReadbackHash',
    'deterministicSliceHash',
    'schemaDerivationHash',
    'renderedCardHash',
    'derivationHash',
  ]) {
    if (declared[field] !== expected.binding[field]) fail(`${prefix}_binding_${field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_mismatch`);
  }
  const suppliedCardHash = sha256Bytes(suppliedBytes);
  if (suppliedCardHash !== declared.renderedCardHash) fail(`${prefix}_declared_card_hash_mismatch`);
  if (!suppliedBytes.equals(expected.bytes)) fail(`${prefix}_deterministic_rerender_byte_mismatch`);
  const visual = await decodeProofCard(suppliedBytes, limits, fail, prefix);
  return {
    accepted: suppliedBytes.equals(expected.bytes),
    suppliedCardHash,
    expectedCardHash: expected.contentHash,
    bindingHash: recomputedBindingHash,
    derivationHash: expected.derivationHash,
    rendererExecutable: expectedRenderer,
    visual,
    supportOnly: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
  };
}

function normalizeArtifactSet(source, phase, fail) {
  const artifactSet = objectOrNull(source);
  if (!artifactSet) {
    fail(`compute_oracle_${phase}_artifact_set_missing`);
    return null;
  }
  rejectUnknownFields(
    artifactSet,
    ARTIFACT_SET_FIELDS,
    fail,
    `compute_oracle_${phase}_artifact_set_unknown_fields`,
  );
  const schemaVersion = requiredText(
    artifactSet,
    ['schemaVersion', 'schema_version'],
    fail,
    `compute_oracle_${phase}_artifact_set_schema_version`,
  );
  if (schemaVersion && schemaVersion !== COMPUTE_ORACLE_ARTIFACT_SET_SCHEMA_VERSION) {
    fail(`compute_oracle_${phase}_artifact_set_schema_version_invalid`);
  }
  const declarations = {};
  for (const template of ARTIFACT_ROLE_TEMPLATES) {
    declarations[template.key] = requiredObject(
      artifactSet,
      [template.key, template.snake],
      fail,
      `compute_oracle_${phase}_${template.snake}_declaration`,
    );
  }
  return {
    schemaVersion: COMPUTE_ORACLE_ARTIFACT_SET_SCHEMA_VERSION,
    declarations,
  };
}

function normalizeEmbeddedLocators(source, fail) {
  const alias = aliasValue(
    source,
    ['artifactCasLocators', 'artifact_cas_locators'],
    fail,
    'compute_oracle_artifact_cas_locators_alias_conflict',
  );
  if (!alias.present) return new Map();
  if (!Array.isArray(alias.value)) {
    fail('compute_oracle_artifact_cas_locators_invalid');
    return new Map();
  }
  const locators = new Map();
  for (const locator of alias.value) {
    if (!objectOrNull(locator) || typeof locator.role !== 'string') {
      fail('compute_oracle_artifact_cas_locator_invalid');
      continue;
    }
    if (!RECOGNIZED_LOCATOR_ROLES.has(locator.role)) {
      fail('compute_oracle_artifact_cas_locator_role_unrecognized');
      continue;
    }
    if (locators.has(locator.role)) {
      fail(`compute_oracle_${locator.role}_cas_locator_duplicate`);
      continue;
    }
    locators.set(locator.role, locator);
  }
  return locators;
}

function normalizeStateMetadata(source, fail) {
  const result = {};
  for (const field of ['status', 'verdict', 'resultState', 'result_state']) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = source[field];
    if (typeof value !== 'string' || !BENIGN_STATE_VALUES.has(value.trim().toLowerCase())) {
      fail(`compute_oracle_${normalizeAliasKey(field)}_value_not_allowlisted`);
    } else {
      result[normalizeAliasKey(field)] = value.trim().toLowerCase();
    }
  }
  return result;
}

function normalizeBundleAuthorityMetadata(source, fail) {
  const proofAuthorityAlias = aliasValue(
    source,
    ['proofAuthority', 'proof_authority'],
    fail,
    'compute_oracle_bundle_proof_authority_alias_conflict',
  );
  if (
    proofAuthorityAlias.present
    && proofAuthorityAlias.value !== COMPUTE_ORACLE_ARTIFACT_BUNDLE_AUTHORITY
  ) {
    fail('compute_oracle_bundle_proof_authority_invalid');
  }
  return proofAuthorityAlias.present ? proofAuthorityAlias.value : null;
}

function transitionBinding(beforeContext, afterContext, beforeReadback, afterReadback, fail) {
  let accepted = true;
  const requireEqual = (field) => {
    if (beforeContext?.[field] !== afterContext?.[field]) {
      fail(`compute_oracle_transition_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_changed`);
      accepted = false;
    }
  };
  for (const field of ['processId', 'runtimeSession', 'outputTarget', 'oracleCodeHash']) requireEqual(field);
  const requireDistinct = (field) => {
    if (beforeContext?.[field] === afterContext?.[field]) {
      fail(`compute_oracle_transition_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_not_changed`);
      accepted = false;
    }
  };
  for (const field of ['epoch', 'dispatchId', 'changedArtifactHash']) requireDistinct(field);
  if (
    beforeContext?.timestampAfterDispatchMonotonicNs
    && afterContext?.dispatchTimestampMonotonicNs
    && BigInt(afterContext.dispatchTimestampMonotonicNs)
      <= BigInt(beforeContext.timestampAfterDispatchMonotonicNs)
  ) {
    fail('compute_oracle_transition_after_dispatch_not_after_before_output');
    accepted = false;
  }
  if (beforeReadback?.rawHash === afterReadback?.rawHash) {
    fail('compute_oracle_transition_raw_readback_unchanged');
    accepted = false;
  }
  if (beforeReadback?.sliceHash === afterReadback?.sliceHash) {
    fail('compute_oracle_transition_deterministic_slice_unchanged');
    accepted = false;
  }
  return {
    accepted,
    sameProcess: beforeContext?.processId === afterContext?.processId,
    sameRuntimeSession: beforeContext?.runtimeSession === afterContext?.runtimeSession,
    sameOutputTarget: beforeContext?.outputTarget === afterContext?.outputTarget,
    sameOracleCode: beforeContext?.oracleCodeHash === afterContext?.oracleCodeHash,
    epochChanged: beforeContext?.epoch !== afterContext?.epoch,
    dispatchChanged: beforeContext?.dispatchId !== afterContext?.dispatchId,
    artifactChanged: beforeContext?.changedArtifactHash !== afterContext?.changedArtifactHash,
    rawReadbackChanged: beforeReadback?.rawHash !== afterReadback?.rawHash,
    deterministicSliceChanged: beforeReadback?.sliceHash !== afterReadback?.sliceHash,
  };
}

function supportOnlyEnvelope() {
  return {
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    fullRuntimeProven: false,
    full_runtime_proven: false,
    strictRuntimeProofAccepted: false,
    strict_runtime_proof_accepted: false,
    proofAuthority: COMPUTE_ORACLE_ARTIFACT_BUNDLE_AUTHORITY,
    proof_authority: COMPUTE_ORACLE_ARTIFACT_BUNDLE_AUTHORITY,
  };
}

function failureResult(reason, details = {}) {
  const reasons = [reason];
  const verificationId = `compute-oracle-artifact-bundle:sha256:${sha256Object({
    schemaVersion: COMPUTE_ORACLE_ARTIFACT_BUNDLE_VERIFICATION_SCHEMA_VERSION,
    reasons,
  }).slice('sha256:'.length)}`;
  const failedGates = reasons.map((code) => ({ code }));
  return {
    schemaVersion: COMPUTE_ORACLE_ARTIFACT_BUNDLE_VERIFICATION_SCHEMA_VERSION,
    schema_version: COMPUTE_ORACLE_ARTIFACT_BUNDLE_VERIFICATION_SCHEMA_VERSION,
    verificationId,
    verification_id: verificationId,
    present: false,
    accepted: false,
    acceptedAsComputeOracleArtifactEvidence: false,
    accepted_as_compute_oracle_artifact_evidence: false,
    ...supportOnlyEnvelope(),
    reasons,
    failedGates,
    failed_gates: failedGates,
    ...details,
  };
}

async function verifyPhase({
  phase,
  resolvedByRole,
  expectedRuntimeContext,
  trustedCodecs,
  limits,
  roots,
  fail,
}) {
  const schemaResolved = resolvedByRole[`${phase}_readback_schema`];
  const rawResolved = resolvedByRole[`${phase}_raw_readback`];
  const cardResolved = resolvedByRole[`${phase}_rendered_card`];
  const schemaBytes = await readBoundedFile(
    schemaResolved?.resource,
    limits.maxReadbackSchemaBytes,
    limits.metadataChunkBytes,
    roots,
    fail,
  );
  let parsedSchema = null;
  let schema = null;
  if (schemaBytes) {
    finalizeArtifact(schemaResolved, sha256Bytes(schemaBytes));
    parsedSchema = parseBoundedJson(
      schemaBytes,
      `${phase}_readback_schema`,
      limits,
      fail,
    )?.parsed ?? null;
    if (parsedSchema) {
      const schemaConflicts = collectAliasConflicts(parsedSchema, `$.${phase}.readbackSchema`);
      if (schemaConflicts.length > 0) fail(`compute_oracle_${phase}_readback_schema_alias_conflict`);
      const schemaClaims = collectExactClaims(parsedSchema, `$.${phase}.readbackSchema`);
      if (schemaClaims.length > 0) fail(`compute_oracle_${phase}_readback_schema_claims_authority`);
      schema = normalizeReadbackSchema(
        parsedSchema,
        rawResolved?.resource?.size ?? -1,
        limits,
        trustedCodecs,
        fail,
        `compute_oracle_${phase}_readback_schema`,
      );
    }
  }
  const readback = await hashRawAndReadSlice(
    rawResolved?.resource,
    schema?.deterministicSlice,
    limits,
    roots,
    fail,
  );
  if (readback) {
    finalizeArtifact(rawResolved, readback.rawHash);
    if (schema?.rawReadbackHash !== readback.rawHash) {
      fail(`compute_oracle_${phase}_readback_schema_raw_hash_mismatch`);
    }
    if (schema?.deterministicSlice?.hash !== readback.sliceHash) {
      fail(`compute_oracle_${phase}_readback_schema_slice_hash_mismatch`);
    }
  }
  const cardBytes = await readBoundedFile(
    cardResolved?.resource,
    limits.maxRenderedCardBytes,
    limits.metadataChunkBytes,
    roots,
    fail,
  );
  let proofCard = null;
  if (cardBytes) {
    finalizeArtifact(cardResolved, sha256Bytes(cardBytes));
    if (schema && readback) {
      proofCard = await verifyProofCard({
        schema,
        sliceBytes: readback.sliceBytes,
        suppliedBytes: cardBytes,
        limits,
        fail,
        prefix: `compute_oracle_${phase}_proof_card`,
      });
    }
  }
  const runtimeContextMatched = compareRuntimeContexts(
    schema?.runtimeContext,
    expectedRuntimeContext,
    `compute_oracle_${phase}_runtime_context`,
    fail,
  );
  return {
    phase,
    schema,
    schemaArtifactHash: schemaResolved?.contentHash ?? null,
    readback: readback ? {
      rawHash: readback.rawHash,
      sliceHash: readback.sliceHash,
      byteLength: readback.byteLength,
      streamed: readback.streamed,
      hashChunkByteLength: readback.hashChunkByteLength,
      sliceByteLength: readback.sliceByteLength,
    } : null,
    proofCard,
    runtimeContextMatched,
  };
}

async function verifyBundle(source, options) {
  const reasons = [];
  const fail = (code) => {
    if (code && !reasons.includes(code)) reasons.push(code);
  };
  const limits = normalizeLimits(options, fail);
  const bundle = objectOrNull(source);
  if (!bundle) return failureResult('compute_oracle_artifact_bundle_missing');
  const bundleBounds = inspectSerializedBounds(bundle, limits);
  if (!bundleBounds.accepted) {
    return failureResult(`compute_oracle_artifact_bundle_${bundleBounds.reason}`, {
      limits,
      serializedBounds: bundleBounds,
      serialized_bounds: bundleBounds,
    });
  }
  const aliasConflicts = collectAliasConflicts(bundle, '$');
  if (aliasConflicts.length > 0) fail('compute_oracle_alias_conflict');
  const authorityClaims = collectExactClaims(bundle, '$');
  if (authorityClaims.length > 0) fail('compute_oracle_artifact_bundle_claims_authority');
  rejectUnknownFields(bundle, BUNDLE_FIELDS, fail, 'compute_oracle_artifact_bundle_unknown_fields');
  const schemaVersion = requiredText(
    bundle,
    ['schemaVersion', 'schema_version'],
    fail,
    'compute_oracle_artifact_bundle_schema_version',
  );
  if (schemaVersion && schemaVersion !== COMPUTE_ORACLE_ARTIFACT_BUNDLE_SCHEMA_VERSION) {
    fail('compute_oracle_artifact_bundle_schema_version_invalid');
  }
  const stateMetadata = normalizeStateMetadata(bundle, fail);
  const declaredAuthority = normalizeBundleAuthorityMetadata(bundle, fail);
  const provenance = normalizeProvenance(objectOrNull(bundle.provenance), fail);
  const roots = await normalizeAllowedRoots(options, fail);
  const trustedCodecs = normalizeTrustedCodecContracts(options, limits, fail);
  const beforeSource = requiredObject(bundle, ['before'], fail, 'compute_oracle_before');
  const afterSource = requiredObject(bundle, ['after'], fail, 'compute_oracle_after');
  const artifactSets = {
    before: normalizeArtifactSet(beforeSource, 'before', fail),
    after: normalizeArtifactSet(afterSource, 'after', fail),
  };
  const embeddedLocators = normalizeEmbeddedLocators(bundle, fail);
  const expectedSources = {};
  const expectedContexts = {};
  for (const phase of ['before', 'after']) {
    const camel = `expected${phase[0].toUpperCase()}${phase.slice(1)}RuntimeContext`;
    const snake = `expected_${phase}_runtime_context`;
    const alias = aliasValue(options, [camel, snake], fail, `compute_oracle_${phase}_expected_runtime_context_alias_conflict`);
    if (!alias.present) fail(`compute_oracle_${phase}_expected_runtime_context_missing`);
    expectedSources[phase] = alias.value;
    if (objectOrNull(alias.value)) {
      const bounds = inspectSerializedBounds(alias.value, limits);
      if (!bounds.accepted) {
        fail(`compute_oracle_${phase}_expected_runtime_context_${bounds.reason}`);
        expectedSources[phase] = null;
      } else {
        const conflicts = collectAliasConflicts(alias.value, `$.expected.${phase}`);
        if (conflicts.length > 0) {
          aliasConflicts.push(...conflicts);
          fail('compute_oracle_alias_conflict');
        }
        const claims = collectExactClaims(alias.value, `$.expected.${phase}`);
        if (claims.length > 0) {
          authorityClaims.push(...claims);
          fail(`compute_oracle_${phase}_expected_runtime_context_claims_authority`);
        }
      }
    }
    expectedContexts[phase] = normalizeRuntimeContext(
      expectedSources[phase],
      fail,
      `compute_oracle_${phase}_expected_runtime_context`,
    );
  }
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const resources = [];
  const resolvedByRole = {};
  let before = null;
  let after = null;
  try {
    if (roots.length > 0) {
      for (const descriptor of ARTIFACT_ROLES) {
        const declarationSource = artifactSets[descriptor.phase]?.declarations?.[descriptor.key] ?? null;
        resolvedByRole[descriptor.role] = await resolveArtifact({
          declarationSource,
          embeddedLocator: embeddedLocators.get(descriptor.role) ?? null,
          descriptor,
          roots,
          baseDir,
          limits,
          fail,
          resources,
        });
      }
    }
    before = await verifyPhase({
      phase: 'before',
      resolvedByRole,
      expectedRuntimeContext: expectedContexts.before,
      trustedCodecs,
      limits,
      roots,
      fail,
    });
    after = await verifyPhase({
      phase: 'after',
      resolvedByRole,
      expectedRuntimeContext: expectedContexts.after,
      trustedCodecs,
      limits,
      roots,
      fail,
    });
  } finally {
    await Promise.allSettled(resources.map((resource) => resource.handle.close()));
  }
  const transition = transitionBinding(
    before?.schema?.runtimeContext,
    after?.schema?.runtimeContext,
    before?.readback,
    after?.readback,
    fail,
  );
  const artifacts = Object.fromEntries(ARTIFACT_ROLES.map(({ role }) => [
    role,
    artifactEvidence(resolvedByRole[role]) ?? {
      role,
      accepted: false,
      reasons: [`compute_oracle_${role}_unresolved`],
      failedGates: [{ code: `compute_oracle_${role}_unresolved` }],
    },
  ]));
  const checksums = {
    checksumBefore: before?.readback?.rawHash ?? null,
    checksumAfter: after?.readback?.rawHash ?? null,
    checksumBeforeSource: 'verified_before_readback_bytes',
    checksumAfterSource: 'verified_after_readback_bytes',
    declarationAccepted: false,
    distinct: before?.readback?.rawHash !== after?.readback?.rawHash,
  };
  const accepted = reasons.length === 0
    && ARTIFACT_ROLES.every(({ role }) => artifacts[role]?.accepted === true)
    && before?.runtimeContextMatched === true
    && after?.runtimeContextMatched === true
    && before?.proofCard?.accepted === true
    && after?.proofCard?.accepted === true
    && transition.accepted === true
    && checksums.checksumBefore
    && checksums.checksumAfter
    && checksums.distinct;
  const artifactIdentityMaterial = Object.fromEntries(ARTIFACT_ROLES.map(({ role }) => {
    const artifact = artifacts[role];
    return [role, {
      role,
      sourceKind: artifact?.sourceKind ?? null,
      contentHash: artifact?.contentHash ?? null,
      byteLength: artifact?.byteLength ?? null,
      casIdentity: artifact?.casIdentity ?? null,
      locatorFileContentHash: artifact?.locatorFileEvidence?.contentHash ?? null,
      locatorFileByteLength: artifact?.locatorFileEvidence?.byteLength ?? null,
    }];
  }));
  const verificationMaterial = {
    schemaVersion: COMPUTE_ORACLE_ARTIFACT_BUNDLE_VERIFICATION_SCHEMA_VERSION,
    bundleSchemaVersion: schemaVersion,
    artifactIdentity: artifactIdentityMaterial,
    before: before ? {
      schemaDerivationHash: before.schema?.schemaDerivationHash ?? null,
      runtimeContext: before.schema?.runtimeContext ?? null,
      expectedRuntimeContext: expectedContexts.before,
      rawHash: before.readback?.rawHash ?? null,
      sliceHash: before.readback?.sliceHash ?? null,
      cardDerivationHash: before.proofCard?.derivationHash ?? null,
      rendererExecutable: before.proofCard?.rendererExecutable ?? null,
      codecContractHash: before.schema?.dtype?.codecContract?.contractHash ?? null,
    } : null,
    after: after ? {
      schemaDerivationHash: after.schema?.schemaDerivationHash ?? null,
      runtimeContext: after.schema?.runtimeContext ?? null,
      expectedRuntimeContext: expectedContexts.after,
      rawHash: after.readback?.rawHash ?? null,
      sliceHash: after.readback?.sliceHash ?? null,
      cardDerivationHash: after.proofCard?.derivationHash ?? null,
      rendererExecutable: after.proofCard?.rendererExecutable ?? null,
      codecContractHash: after.schema?.dtype?.codecContract?.contractHash ?? null,
    } : null,
    transition,
    checksums,
    provenance,
    stateMetadata,
    declaredAuthority,
    reasons,
  };
  const verificationId = `compute-oracle-artifact-bundle:sha256:${sha256Object(verificationMaterial).slice('sha256:'.length)}`;
  const failedGates = reasons.map((code) => ({ code }));
  return {
    schemaVersion: COMPUTE_ORACLE_ARTIFACT_BUNDLE_VERIFICATION_SCHEMA_VERSION,
    schema_version: COMPUTE_ORACLE_ARTIFACT_BUNDLE_VERIFICATION_SCHEMA_VERSION,
    verificationId,
    verification_id: verificationId,
    present: true,
    accepted: Boolean(accepted),
    acceptedAsComputeOracleArtifactEvidence: Boolean(accepted),
    accepted_as_compute_oracle_artifact_evidence: Boolean(accepted),
    ...supportOnlyEnvelope(),
    limits,
    allowedRoots: roots,
    artifacts,
    before,
    after,
    checksums,
    transition,
    provenance,
    stateMetadata,
    aliasConflicts,
    authorityClaims,
    evidenceRefs: [...new Set([
      ...Object.values(artifacts).map((artifact) => artifact?.contentHash),
      ...Object.values(artifacts).map((artifact) => artifact?.casIdentity?.manifestHash),
      before?.proofCard?.bindingHash,
      after?.proofCard?.bindingHash,
      before?.schema?.runtimeContext?.contextHash,
      after?.schema?.runtimeContext?.contextHash,
    ].filter(Boolean))].sort(),
    reasons,
    failedGates,
    failed_gates: failedGates,
  };
}

export async function verifyComputeOracleArtifactBundle(computeArtifacts = null, options = {}) {
  try {
    return await verifyBundle(computeArtifacts, options);
  } catch (error) {
    return failureResult('compute_oracle_artifact_bundle_unexpected_exception', {
      unexpectedError: error?.message ? String(error.message) : String(error),
      unexpected_error: error?.message ? String(error.message) : String(error),
    });
  }
}
