import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
  GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
  GPU_HMR_SHARED_ARTIFACT_ADDRESSING_SCHEMA_VERSION,
  artifactIdForHash,
  casRelativePathForHash,
  sha256Bytes,
  sha256Text,
  stableJson,
  validateArtifactCasManifest,
} from './gpu-hmr-artifact-cas.mjs';
import { createColdBuildInputSet } from './gpu-hmr-cold-build-input-set.mjs';

export const ARBITRARY_COLD_PROJECT_RUN_FACET_PROOF_MODE =
  'arbitrary_cold_project_run';
export const ARBITRARY_COLD_PROJECT_RUN_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_run.v1';
export const ARBITRARY_COLD_PROJECT_RUN_AUTHORITY =
  'orchestrated_cold_build_evidence_only_not_gpu_hmr_success';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_CAS_SEGMENT_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const MAX_OUTPUT_COUNT = 100_000;
const AUTHORITY_FLAG_KEYS = new Set([
  'acceptedforgpuhmr',
  'gpuhmrsuccess',
  'cansatisfyruntimeproof',
  'cansatisfydispatchproof',
]);

const ENVELOPE_KEYS = ['descriptorBytesHash', 'evidence', 'outputs'];
const EVIDENCE_KEYS = [
  'schemaVersion',
  'proofAuthority',
  'descriptorHash',
  'sourcePathIdentityHash',
  'sourceBindingHash',
  'sourceTreeBindingEvidenceHash',
  'sourceSnapshotEvidenceHash',
  'inputSetBindings',
  'inputSetHash',
  'readOnlyInputBindings',
  'readOnlyInputBindingSetHash',
  'readOnlyInputSnapshotBindings',
  'readOnlyInputSnapshotSetHash',
  'readOnlyInputCount',
  'readOnlyInputEntryCount',
  'readOnlyInputByteLength',
  'workerImageEvidenceHash',
  'workerImageId',
  'contractHash',
  'commandSpecHash',
  'launcherExecutableHash',
  'planHash',
  'driverExecutionEvidenceHash',
  'outputEvidenceHash',
  'outputSetHash',
  'outputContractHash',
  'artifactSessionRootIdentityHash',
  'artifactLocatorSetHash',
  'artifactCount',
  'timings',
  'coldBuildSucceeded',
  'acceptedAsColdBuildEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
];
const TIMING_KEYS = [
  'metricClock',
  'metricScope',
  'artifactRootValidationNanos',
  'imageInspectionNanos',
  'sourceBindingNanos',
  'readOnlyInputBindingNanos',
  'launcherMaterializationNanos',
  'executionNanos',
  'outputEvidenceNanos',
  'artifactPersistenceNanos',
  'totalRunnerWallNanos',
];
const READ_ONLY_BINDING_KEYS = [
  'mountPath',
  'sourceBindingHash',
  'sourceTreeBindingEvidenceHash',
  'entryCount',
  'totalByteLength',
];
const READ_ONLY_SNAPSHOT_BINDING_KEYS = ['mountPath', 'snapshotEvidenceHash'];
const OUTPUT_KEYS = ['metadata', 'artifactLocator', 'transportEvidence'];
const OUTPUT_METADATA_KEYS = [
  'path',
  'declaredRole',
  'declaredArtifactKind',
  'declaredMediaType',
  'declaredContentHash',
  'declaredByteLength',
  'observedContentHash',
  'observedByteLength',
  'mode',
  'metadataAuthority',
];
const LOCATOR_KEYS = [
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
  'manifestHash',
];
const SHARED_STORAGE_KEYS = [
  'schemaVersion',
  'addressing',
  'contentHash',
  'relativePath',
  'mountCount',
  'mountRoles',
  'mounts',
  'manifestOnly',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'proofAuthority',
];

class FacetGateError extends Error {
  constructor(gate) {
    super(gate);
    this.gate = gate;
  }
}

function fail(gate) {
  throw new FacetGateError(gate);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function requireExactObject(value, keys, gate) {
  if (!exactKeys(value, keys)) fail(gate);
  return value;
}

function requireHash(value, gate) {
  if (!HASH_PATTERN.test(value ?? '')) fail(gate);
  return value;
}

function requireSafeInteger(value, gate, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(gate);
  return value;
}

function requireProtocolText(value, gate, maximumLength = 32 * 1024) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || /[\0\r\n]/.test(value)
  ) {
    fail(gate);
  }
  return value;
}

function normalizeAuthorityKey(value) {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function containsTrueAuthorityClaim(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const entries = Array.isArray(value)
    ? value.map((entry) => [null, entry])
    : Object.entries(value);
  for (const [key, entry] of entries) {
    if (key !== null && AUTHORITY_FLAG_KEYS.has(normalizeAuthorityKey(key)) && entry === true) {
      return true;
    }
    if (containsTrueAuthorityClaim(entry, seen)) return true;
  }
  seen.delete(value);
  return false;
}

function hashCanonical(value) {
  return sha256Text(stableJson(value));
}

function recomputeEvidenceHash(evidence) {
  const projection = { ...evidence };
  delete projection.evidenceHash;
  return hashCanonical(projection);
}

function pathIdentityHash(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return sha256Text(process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function normalizeRelativeOutputPath(value) {
  requireProtocolText(value, 'arbitrary_cold_project_run_output_path_invalid');
  if (/[\\]/.test(value)) fail('arbitrary_cold_project_run_output_path_invalid');
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
  ) {
    fail('arbitrary_cold_project_run_output_path_invalid');
  }
  return normalized;
}

function validateTimingEvidence(timings) {
  requireExactObject(
    timings,
    TIMING_KEYS,
    'arbitrary_cold_project_run_timings_shape_invalid',
  );
  if (timings.metricClock !== 'monotonic_ns' || timings.metricScope !== 'cold') {
    fail('arbitrary_cold_project_run_timings_authority_invalid');
  }
  for (const key of TIMING_KEYS.filter((name) => name.endsWith('Nanos'))) {
    requireSafeInteger(timings[key], 'arbitrary_cold_project_run_timing_invalid');
  }
}

function validateReadOnlyAggregates(evidence) {
  if (!Array.isArray(evidence.readOnlyInputBindings) || evidence.readOnlyInputBindings.length > 128) {
    fail('arbitrary_cold_project_run_read_only_bindings_invalid');
  }
  const bindings = evidence.readOnlyInputBindings.map((binding) => {
    requireExactObject(
      binding,
      READ_ONLY_BINDING_KEYS,
      'arbitrary_cold_project_run_read_only_binding_shape_invalid',
    );
    requireProtocolText(
      binding.mountPath,
      'arbitrary_cold_project_run_read_only_mount_path_invalid',
      1024,
    );
    requireHash(
      binding.sourceBindingHash,
      'arbitrary_cold_project_run_read_only_source_hash_invalid',
    );
    requireHash(
      binding.sourceTreeBindingEvidenceHash,
      'arbitrary_cold_project_run_read_only_evidence_hash_invalid',
    );
    requireSafeInteger(
      binding.entryCount,
      'arbitrary_cold_project_run_read_only_entry_count_invalid',
    );
    requireSafeInteger(
      binding.totalByteLength,
      'arbitrary_cold_project_run_read_only_byte_length_invalid',
    );
    return {
      mountPath: binding.mountPath,
      sourceBindingHash: binding.sourceBindingHash,
      sourceTreeBindingEvidenceHash: binding.sourceTreeBindingEvidenceHash,
      entryCount: binding.entryCount,
      totalByteLength: binding.totalByteLength,
    };
  });
  const sortedBindings = [...bindings].sort((left, right) => (
    left.mountPath.localeCompare(right.mountPath)
  ));
  if (stableJson(bindings) !== stableJson(sortedBindings)) {
    fail('arbitrary_cold_project_run_read_only_binding_order_invalid');
  }

  let inputSet;
  try {
    inputSet = createColdBuildInputSet({
      sourceBindingHash: evidence.sourceBindingHash,
      readOnlyInputs: bindings.map(({ mountPath, sourceBindingHash }) => ({
        mountPath,
        sourceBindingHash,
      })),
    });
  } catch {
    fail('arbitrary_cold_project_run_input_set_invalid');
  }
  if (stableJson(evidence.inputSetBindings) !== stableJson(inputSet.entries)) {
    fail('arbitrary_cold_project_run_input_set_bindings_mismatch');
  }
  if (evidence.inputSetHash !== inputSet.inputSetHash) {
    fail('arbitrary_cold_project_run_input_set_hash_mismatch');
  }
  if (evidence.readOnlyInputBindingSetHash !== hashCanonical(bindings)) {
    fail('arbitrary_cold_project_run_read_only_binding_set_hash_mismatch');
  }

  if (
    !Array.isArray(evidence.readOnlyInputSnapshotBindings)
    || evidence.readOnlyInputSnapshotBindings.length !== bindings.length
  ) {
    fail('arbitrary_cold_project_run_read_only_snapshot_bindings_invalid');
  }
  const snapshotBindings = evidence.readOnlyInputSnapshotBindings.map((snapshot, index) => {
    requireExactObject(
      snapshot,
      READ_ONLY_SNAPSHOT_BINDING_KEYS,
      'arbitrary_cold_project_run_read_only_snapshot_binding_shape_invalid',
    );
    requireHash(
      snapshot.snapshotEvidenceHash,
      'arbitrary_cold_project_run_read_only_snapshot_hash_invalid',
    );
    if (snapshot.mountPath !== bindings[index].mountPath) {
      fail('arbitrary_cold_project_run_read_only_snapshot_mount_mismatch');
    }
    return {
      mountPath: snapshot.mountPath,
      snapshotEvidenceHash: snapshot.snapshotEvidenceHash,
    };
  });
  if (evidence.readOnlyInputSnapshotSetHash !== hashCanonical(snapshotBindings)) {
    fail('arbitrary_cold_project_run_read_only_snapshot_set_hash_mismatch');
  }

  const entryCount = bindings.reduce((total, binding) => total + binding.entryCount, 0);
  const byteLength = bindings.reduce((total, binding) => total + binding.totalByteLength, 0);
  if (!Number.isSafeInteger(entryCount) || !Number.isSafeInteger(byteLength)) {
    fail('arbitrary_cold_project_run_read_only_aggregate_overflow');
  }
  if (
    evidence.readOnlyInputCount !== bindings.length
    || evidence.readOnlyInputEntryCount !== entryCount
    || evidence.readOnlyInputByteLength !== byteLength
  ) {
    fail('arbitrary_cold_project_run_read_only_aggregate_mismatch');
  }
  return { inputSet, bindings, snapshotBindings };
}

function validateEvidence(evidence) {
  requireExactObject(
    evidence,
    EVIDENCE_KEYS,
    'arbitrary_cold_project_run_evidence_shape_invalid',
  );
  if (evidence.schemaVersion !== ARBITRARY_COLD_PROJECT_RUN_SCHEMA) {
    fail('arbitrary_cold_project_run_schema_invalid');
  }
  if (evidence.proofAuthority !== ARBITRARY_COLD_PROJECT_RUN_AUTHORITY) {
    fail('arbitrary_cold_project_run_authority_invalid');
  }
  if (
    evidence.acceptedForGpuHmr !== false
    || evidence.gpuHmrSuccess !== false
    || evidence.canSatisfyRuntimeProof !== false
    || evidence.canSatisfyDispatchProof !== false
  ) {
    fail('arbitrary_cold_project_run_authority_flags_invalid');
  }
  if (containsTrueAuthorityClaim(evidence)) {
    fail('arbitrary_cold_project_run_nested_authority_claim');
  }
  if (evidence.coldBuildSucceeded !== true || evidence.acceptedAsColdBuildEvidence !== true) {
    fail('arbitrary_cold_project_run_cold_build_acceptance_invalid');
  }

  const opaqueHashFields = [
    'descriptorHash',
    'sourcePathIdentityHash',
    'sourceBindingHash',
    'sourceTreeBindingEvidenceHash',
    'sourceSnapshotEvidenceHash',
    'inputSetHash',
    'readOnlyInputBindingSetHash',
    'readOnlyInputSnapshotSetHash',
    'workerImageEvidenceHash',
    'workerImageId',
    'contractHash',
    'commandSpecHash',
    'launcherExecutableHash',
    'planHash',
    'driverExecutionEvidenceHash',
    'outputEvidenceHash',
    'outputSetHash',
    'outputContractHash',
    'artifactSessionRootIdentityHash',
    'artifactLocatorSetHash',
    'evidenceHash',
  ];
  for (const field of opaqueHashFields) {
    requireHash(evidence[field], `arbitrary_cold_project_run_${field}_invalid`);
  }
  requireSafeInteger(
    evidence.readOnlyInputCount,
    'arbitrary_cold_project_run_read_only_input_count_invalid',
  );
  requireSafeInteger(
    evidence.readOnlyInputEntryCount,
    'arbitrary_cold_project_run_read_only_input_entry_count_invalid',
  );
  requireSafeInteger(
    evidence.readOnlyInputByteLength,
    'arbitrary_cold_project_run_read_only_input_byte_length_invalid',
  );
  requireSafeInteger(evidence.artifactCount, 'arbitrary_cold_project_run_artifact_count_invalid', 1);
  validateTimingEvidence(evidence.timings);
  if (recomputeEvidenceHash(evidence) !== evidence.evidenceHash) {
    fail('arbitrary_cold_project_run_evidence_hash_mismatch');
  }
  return validateReadOnlyAggregates(evidence);
}

function validateOutputMetadata(outputs, evidence) {
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > MAX_OUTPUT_COUNT) {
    fail('arbitrary_cold_project_run_outputs_invalid');
  }
  const metadata = outputs.map((output) => {
    requireExactObject(output, OUTPUT_KEYS, 'arbitrary_cold_project_run_output_shape_invalid');
    requireExactObject(
      output.metadata,
      OUTPUT_METADATA_KEYS,
      'arbitrary_cold_project_run_output_metadata_shape_invalid',
    );
    const entry = output.metadata;
    const outputPath = normalizeRelativeOutputPath(entry.path);
    requireProtocolText(entry.declaredRole, 'arbitrary_cold_project_run_output_role_invalid');
    requireProtocolText(
      entry.declaredArtifactKind,
      'arbitrary_cold_project_run_output_artifact_kind_invalid',
    );
    requireProtocolText(
      entry.declaredMediaType,
      'arbitrary_cold_project_run_output_media_type_invalid',
      160,
    );
    requireHash(
      entry.declaredContentHash,
      'arbitrary_cold_project_run_output_declared_hash_invalid',
    );
    requireHash(
      entry.observedContentHash,
      'arbitrary_cold_project_run_output_observed_hash_invalid',
    );
    requireSafeInteger(
      entry.declaredByteLength,
      'arbitrary_cold_project_run_output_declared_byte_length_invalid',
    );
    requireSafeInteger(
      entry.observedByteLength,
      'arbitrary_cold_project_run_output_observed_byte_length_invalid',
    );
    requireSafeInteger(entry.mode, 'arbitrary_cold_project_run_output_mode_invalid');
    if (entry.mode > 0o777) fail('arbitrary_cold_project_run_output_mode_invalid');
    if (
      entry.declaredContentHash !== entry.observedContentHash
      || entry.declaredByteLength !== entry.observedByteLength
    ) {
      fail('arbitrary_cold_project_run_output_declared_observed_mismatch');
    }
    if (entry.metadataAuthority !== 'advisory_only_not_output_acceptance') {
      fail('arbitrary_cold_project_run_output_metadata_authority_invalid');
    }
    return { ...entry, path: outputPath };
  });
  const sorted = [...metadata].sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
  if (stableJson(metadata) !== stableJson(sorted)) {
    fail('arbitrary_cold_project_run_output_order_invalid');
  }
  if (new Set(metadata.map((entry) => entry.path)).size !== metadata.length) {
    fail('arbitrary_cold_project_run_output_path_duplicate');
  }
  if (evidence.artifactCount !== metadata.length) {
    fail('arbitrary_cold_project_run_artifact_count_mismatch');
  }
  if (evidence.outputSetHash !== hashCanonical(metadata)) {
    fail('arbitrary_cold_project_run_output_set_hash_mismatch');
  }
  const outputContract = metadata.map((entry) => ({
    path: entry.path,
    declaredRole: entry.declaredRole,
    declaredArtifactKind: entry.declaredArtifactKind,
    declaredMediaType: entry.declaredMediaType,
  }));
  if (evidence.outputContractHash !== hashCanonical(outputContract)) {
    fail('arbitrary_cold_project_run_output_contract_hash_mismatch');
  }
  return metadata;
}

async function normalizeTrustedRoots(options) {
  const explicit = [];
  if (Object.hasOwn(options, 'trustedCasRoots')) {
    if (!Array.isArray(options.trustedCasRoots)) {
      fail('arbitrary_cold_project_run_trusted_roots_invalid');
    }
    explicit.push(...options.trustedCasRoots);
  }
  if (Object.hasOwn(options, 'allowedRoots')) {
    if (!Array.isArray(options.allowedRoots)) {
      fail('arbitrary_cold_project_run_trusted_roots_invalid');
    }
    explicit.push(...options.allowedRoots);
  }
  if (Object.hasOwn(options, 'artifactRoot')) explicit.push(options.artifactRoot);
  if (explicit.length < 1 || explicit.length > 128) {
    fail('arbitrary_cold_project_run_trusted_roots_required');
  }

  const roots = [];
  for (const value of explicit) {
    if (typeof value !== 'string' || value.length < 1 || /[\0\r\n]/.test(value)) {
      fail('arbitrary_cold_project_run_trusted_roots_invalid');
    }
    try {
      const canonicalPath = await realpath(path.resolve(value));
      const metadata = await lstat(canonicalPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        fail('arbitrary_cold_project_run_trusted_roots_invalid');
      }
      if (!roots.some((root) => comparablePath(root) === comparablePath(canonicalPath))) {
        roots.push(canonicalPath);
      }
    } catch (error) {
      if (error instanceof FacetGateError) throw error;
      fail('arbitrary_cold_project_run_trusted_roots_invalid');
    }
  }
  if (roots.length < 1) fail('arbitrary_cold_project_run_trusted_roots_required');
  return roots;
}

function normalizePortableRoot(value) {
  if (typeof value !== 'string' || value.length < 1 || /[\0\r\n]/.test(value)) {
    fail('arbitrary_cold_project_run_shared_storage_mount_invalid');
  }
  return value.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/+$/g, '') || '/';
}

function validateSharedStorage(locator, relativePath) {
  const hasCamel = Object.hasOwn(locator, 'sharedStorage');
  const hasSnake = Object.hasOwn(locator, 'shared_storage');
  if (!hasCamel && !hasSnake) return;
  if (!hasCamel || !hasSnake || stableJson(locator.sharedStorage) !== stableJson(locator.shared_storage)) {
    fail('arbitrary_cold_project_run_shared_storage_alias_mismatch');
  }
  const shared = requireExactObject(
    locator.sharedStorage,
    SHARED_STORAGE_KEYS,
    'arbitrary_cold_project_run_shared_storage_shape_invalid',
  );
  if (
    shared.schemaVersion !== GPU_HMR_SHARED_ARTIFACT_ADDRESSING_SCHEMA_VERSION
    || shared.addressing !== 'content_addressed_relative_path'
    || shared.contentHash !== locator.contentHash
    || shared.relativePath !== relativePath
    || shared.manifestOnly !== true
    || shared.acceptedForGpuHmr !== false
    || shared.gpuHmrSuccess !== false
    || shared.proofAuthority !== 'shared_artifact_addressing_only'
  ) {
    fail('arbitrary_cold_project_run_shared_storage_binding_invalid');
  }
  if (!Array.isArray(shared.mounts) || shared.mounts.length < 1) {
    fail('arbitrary_cold_project_run_shared_storage_mounts_invalid');
  }
  const roles = shared.mounts.map((mount) => {
    requireExactObject(
      mount,
      ['role', 'root', 'path', 'addressKind', 'readableBytesProven'],
      'arbitrary_cold_project_run_shared_storage_mount_shape_invalid',
    );
    if (
      !SAFE_CAS_SEGMENT_PATTERN.test(mount.role ?? '')
      || !SAFE_CAS_SEGMENT_PATTERN.test(mount.addressKind ?? '')
      || mount.readableBytesProven !== false
    ) {
      fail('arbitrary_cold_project_run_shared_storage_mount_invalid');
    }
    const root = normalizePortableRoot(mount.root);
    if (mount.root !== root || mount.path !== `${root}/${relativePath}`) {
      fail('arbitrary_cold_project_run_shared_storage_mount_path_invalid');
    }
    return mount.role;
  });
  const sortedRoles = [...roles].sort();
  if (
    shared.mountCount !== shared.mounts.length
    || stableJson(shared.mountRoles) !== stableJson(sortedRoles)
  ) {
    fail('arbitrary_cold_project_run_shared_storage_aggregate_mismatch');
  }
}

function expectedTransportKind(sessionRoot) {
  if (
    sameOrInside(sessionRoot, path.resolve('/dev/shm'))
    || sameOrInside(sessionRoot, path.resolve(os.tmpdir()))
  ) {
    return 'cas_tmpfs';
  }
  return 'cas_shared_volume';
}

function validateLocatorShape(locator, metadata, planHash) {
  const sharedKeys = Object.hasOwn(locator ?? {}, 'sharedStorage')
    || Object.hasOwn(locator ?? {}, 'shared_storage')
    ? ['sharedStorage', 'shared_storage']
    : [];
  requireExactObject(
    locator,
    [...LOCATOR_KEYS, ...sharedKeys],
    'arbitrary_cold_project_run_artifact_locator_shape_invalid',
  );
  const contentHash = metadata.observedContentHash;
  const relativePath = casRelativePathForHash(contentHash);
  const expectedNamespace = `cold-${planHash.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  if (
    locator.schemaVersion !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION
    || locator.artifactId !== artifactIdForHash(contentHash)
    || locator.contentHash !== contentHash
    || locator.artifactKind !== 'cold_build_artifact'
    || locator.byteLength !== metadata.observedByteLength
    || locator.mediaType !== metadata.declaredMediaType
    || locator.role !== 'cold_build_output'
    || locator.producerSubsystem !== 'gpu_hmr_cold_path'
    || locator.sessionNamespace !== expectedNamespace
    || locator.artifactUri
      !== `synthi-cas://${expectedNamespace}/sha256/${contentHash.slice('sha256:'.length)}`
    || locator.proofAuthority !== 'transport_integrity_only'
    || locator.acceptedForGpuHmr !== false
    || locator.gpuHmrSuccess !== false
  ) {
    fail('arbitrary_cold_project_run_artifact_locator_binding_invalid');
  }
  requireExactObject(
    locator.producer,
    ['name', 'kind'],
    'arbitrary_cold_project_run_artifact_producer_shape_invalid',
  );
  if (
    locator.producer.name !== 'arbitrary_cold_project_runner'
    || locator.producer.kind !== 'cold_build'
  ) {
    fail('arbitrary_cold_project_run_artifact_producer_invalid');
  }
  requireExactObject(
    locator.transport,
    ['kind', 'contentAddressed', 'manifestOnly', 'bytesEmbedded', 'hotPathOptimized'],
    'arbitrary_cold_project_run_artifact_transport_shape_invalid',
  );
  if (
    !['cas_shared_volume', 'cas_tmpfs'].includes(locator.transport.kind)
    || locator.transport.contentAddressed !== true
    || locator.transport.manifestOnly !== true
    || locator.transport.bytesEmbedded !== false
    || locator.transport.hotPathOptimized !== true
  ) {
    fail('arbitrary_cold_project_run_artifact_transport_invalid');
  }
  requireExactObject(
    locator.storage,
    ['kind', 'localPath', 'relativePath'],
    'arbitrary_cold_project_run_artifact_storage_shape_invalid',
  );
  if (
    locator.storage.kind !== locator.transport.kind
    || locator.storage.relativePath !== relativePath
    || typeof locator.storage.localPath !== 'string'
    || !path.isAbsolute(locator.storage.localPath)
  ) {
    fail('arbitrary_cold_project_run_artifact_storage_binding_invalid');
  }
  requireHash(locator.manifestHash, 'arbitrary_cold_project_run_artifact_manifest_hash_invalid');
  validateSharedStorage(locator, relativePath);
  const recomputedManifestHash = sha256Text(stableJson({
    ...locator,
    manifestHash: undefined,
  }));
  if (locator.manifestHash !== recomputedManifestHash) {
    fail('arbitrary_cold_project_run_artifact_manifest_hash_mismatch');
  }
  return { contentHash, relativePath };
}

async function resolveAndHashTrustedCasFile(localPath, relativePath, trustedRoots, expected) {
  let canonicalPath;
  try {
    canonicalPath = await realpath(localPath);
  } catch {
    fail('arbitrary_cold_project_run_artifact_path_unreadable');
  }
  if (comparablePath(canonicalPath) !== comparablePath(localPath)) {
    fail('arbitrary_cold_project_run_artifact_path_noncanonical');
  }
  if (!trustedRoots.some((root) => sameOrInside(canonicalPath, root))) {
    fail('arbitrary_cold_project_run_artifact_path_untrusted');
  }

  const relativeSegments = relativePath.split('/');
  let sessionRoot = canonicalPath;
  for (const _segment of relativeSegments) sessionRoot = path.dirname(sessionRoot);
  let canonicalSessionRoot;
  try {
    canonicalSessionRoot = await realpath(sessionRoot);
  } catch {
    fail('arbitrary_cold_project_run_artifact_session_root_invalid');
  }
  if (
    comparablePath(canonicalSessionRoot) !== comparablePath(sessionRoot)
    || !trustedRoots.some((root) => sameOrInside(canonicalSessionRoot, root))
    || comparablePath(path.join(canonicalSessionRoot, ...relativeSegments))
      !== comparablePath(canonicalPath)
  ) {
    fail('arbitrary_cold_project_run_artifact_relative_path_mismatch');
  }

  const casPaths = [
    canonicalSessionRoot,
    path.join(canonicalSessionRoot, relativeSegments[0]),
    path.join(canonicalSessionRoot, relativeSegments[0], relativeSegments[1]),
    canonicalPath,
  ];
  try {
    for (let index = 0; index < casPaths.length; index += 1) {
      const metadata = await lstat(casPaths[index]);
      if (metadata.isSymbolicLink()) fail('arbitrary_cold_project_run_artifact_path_symlink');
      if (index < casPaths.length - 1 && !metadata.isDirectory()) {
        fail('arbitrary_cold_project_run_artifact_path_invalid');
      }
      if (index === casPaths.length - 1 && !metadata.isFile()) {
        fail('arbitrary_cold_project_run_artifact_path_invalid');
      }
    }
  } catch (error) {
    if (error instanceof FacetGateError) throw error;
    fail('arbitrary_cold_project_run_artifact_path_unreadable');
  }

  let handle;
  try {
    handle = await open(canonicalPath, 'r');
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail('arbitrary_cold_project_run_artifact_path_invalid');
    if (before.size !== BigInt(expected.byteLength)) {
      fail('arbitrary_cold_project_run_output_cas_byte_length_mismatch');
    }
    const hasher = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < expected.byteLength) {
      const requested = Math.min(buffer.byteLength, expected.byteLength - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead < 1) fail('arbitrary_cold_project_run_artifact_path_unreadable');
      hasher.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
    ) {
      fail('arbitrary_cold_project_run_artifact_changed_during_read');
    }
    const observedHash = `sha256:${hasher.digest('hex')}`;
    if (observedHash !== expected.contentHash) {
      fail('arbitrary_cold_project_run_output_cas_hash_mismatch');
    }
  } catch (error) {
    if (error instanceof FacetGateError) throw error;
    fail('arbitrary_cold_project_run_artifact_path_unreadable');
  } finally {
    await handle?.close().catch(() => {});
  }
  return { canonicalPath, sessionRoot: canonicalSessionRoot };
}

async function validateOutputCas(output, metadata, evidence, trustedRoots) {
  const locator = output.artifactLocator;
  const locatorShape = validateLocatorShape(locator, metadata, evidence.planHash);
  let transportValidation;
  try {
    transportValidation = await validateArtifactCasManifest(locator, {
      allowedRoots: trustedRoots,
    });
  } catch {
    fail('arbitrary_cold_project_run_artifact_transport_validation_failed');
  }
  if (transportValidation.accepted !== true) {
    const untrusted = transportValidation.reasons?.some((reason) => (
      reason === 'artifact_cas_local_path_outside_allowed_roots'
      || reason === 'artifact_cas_allowed_root_required_for_local_path'
    ));
    fail(untrusted
      ? 'arbitrary_cold_project_run_artifact_path_untrusted'
      : 'arbitrary_cold_project_run_artifact_transport_invalid');
  }
  if (
    transportValidation.schemaVersion !== GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION
    || transportValidation.acceptedAsTransportEvidence !== true
    || transportValidation.acceptedForGpuHmr !== false
    || transportValidation.gpuHmrSuccess !== false
    || transportValidation.proofAuthority !== 'transport_integrity_only'
    || stableJson(output.transportEvidence) !== stableJson(transportValidation)
  ) {
    fail('arbitrary_cold_project_run_transport_evidence_mismatch');
  }
  const resolved = await resolveAndHashTrustedCasFile(
    locator.storage.localPath,
    locatorShape.relativePath,
    trustedRoots,
    {
      contentHash: metadata.observedContentHash,
      byteLength: metadata.observedByteLength,
    },
  );
  if (locator.transport.kind !== expectedTransportKind(resolved.sessionRoot)) {
    fail('arbitrary_cold_project_run_artifact_transport_kind_mismatch');
  }
  return resolved;
}

async function validateOutputs(outputs, metadata, evidence, trustedRoots) {
  const sessionRoots = [];
  for (let index = 0; index < outputs.length; index += 1) {
    const resolved = await validateOutputCas(
      outputs[index],
      metadata[index],
      evidence,
      trustedRoots,
    );
    sessionRoots.push(resolved.sessionRoot);
  }
  if (sessionRoots.some((root) => comparablePath(root) !== comparablePath(sessionRoots[0]))) {
    fail('arbitrary_cold_project_run_artifact_session_root_mismatch');
  }
  if (evidence.artifactSessionRootIdentityHash !== pathIdentityHash(sessionRoots[0])) {
    fail('arbitrary_cold_project_run_artifact_session_identity_hash_mismatch');
  }
  const locatorProjection = outputs.map((output, index) => ({
    path: metadata[index].path,
    contentHash: metadata[index].observedContentHash,
    byteLength: metadata[index].observedByteLength,
    artifactId: output.artifactLocator.artifactId,
    manifestHash: output.artifactLocator.manifestHash,
    transportKind: output.artifactLocator.transport.kind,
  }));
  if (evidence.artifactLocatorSetHash !== hashCanonical(locatorProjection)) {
    fail('arbitrary_cold_project_run_artifact_locator_set_hash_mismatch');
  }
  return { locatorProjection, sessionRoot: sessionRoots[0] };
}

function bytesFromOption(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  fail('arbitrary_cold_project_run_descriptor_bytes_invalid');
}

async function validateEnvelope(envelope, options) {
  requireExactObject(envelope, ENVELOPE_KEYS, 'arbitrary_cold_project_run_envelope_shape_invalid');
  requireHash(
    envelope.descriptorBytesHash,
    'arbitrary_cold_project_run_descriptor_bytes_hash_invalid',
  );
  if (Object.hasOwn(options, 'descriptorBytes')) {
    const descriptorBytesHash = sha256Bytes(bytesFromOption(options.descriptorBytes));
    if (descriptorBytesHash !== envelope.descriptorBytesHash) {
      fail('arbitrary_cold_project_run_descriptor_bytes_hash_mismatch');
    }
  }
  if (Object.hasOwn(options, 'expectedDescriptorBytesHash')) {
    requireHash(
      options.expectedDescriptorBytesHash,
      'arbitrary_cold_project_run_expected_descriptor_hash_invalid',
    );
    if (options.expectedDescriptorBytesHash !== envelope.descriptorBytesHash) {
      fail('arbitrary_cold_project_run_descriptor_bytes_hash_mismatch');
    }
  }
  if (containsTrueAuthorityClaim(envelope)) {
    fail('arbitrary_cold_project_run_nested_authority_claim');
  }
  const aggregate = validateEvidence(envelope.evidence);
  const metadata = validateOutputMetadata(envelope.outputs, envelope.evidence);
  const trustedRoots = await normalizeTrustedRoots(options);
  const outputValidation = await validateOutputs(
    envelope.outputs,
    metadata,
    envelope.evidence,
    trustedRoots,
  );
  return {
    aggregate,
    metadata,
    outputValidation,
    descriptorBytesHash: envelope.descriptorBytesHash,
    descriptorHash: envelope.evidence.descriptorHash,
    evidenceHash: envelope.evidence.evidenceHash,
    inputSetHash: aggregate.inputSet.inputSetHash,
    outputSetHash: hashCanonical(metadata),
    artifactLocatorSetHash: hashCanonical(outputValidation.locatorProjection),
  };
}

function classification({ present, accepted, validated = null, failedGates = [] }) {
  const descriptorBytesHash = validated?.descriptorBytesHash ?? null;
  const descriptorHash = validated?.descriptorHash ?? null;
  const evidenceHash = validated?.evidenceHash ?? null;
  const inputSetHash = validated?.inputSetHash ?? null;
  const outputSetHash = validated?.outputSetHash ?? null;
  const artifactLocatorSetHash = validated?.artifactLocatorSetHash ?? null;
  const artifactCount = validated?.metadata?.length ?? 0;
  return {
    present,
    accepted,
    matrixRecomputed: true,
    matrix_recomputed: true,
    proofMode: ARBITRARY_COLD_PROJECT_RUN_FACET_PROOF_MODE,
    proof_mode: ARBITRARY_COLD_PROJECT_RUN_FACET_PROOF_MODE,
    schemaVersion: ARBITRARY_COLD_PROJECT_RUN_SCHEMA,
    schema_version: ARBITRARY_COLD_PROJECT_RUN_SCHEMA,
    proofAuthority: ARBITRARY_COLD_PROJECT_RUN_AUTHORITY,
    proof_authority: ARBITRARY_COLD_PROJECT_RUN_AUTHORITY,
    authorityScope: 'support_only',
    authority_scope: 'support_only',
    supportOnly: true,
    support_only: true,
    acceptedAsSupportEvidence: accepted,
    accepted_as_support_evidence: accepted,
    acceptedAsColdBuildEvidence: accepted,
    accepted_as_cold_build_evidence: accepted,
    coldBuildSucceeded: accepted,
    cold_build_succeeded: accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    canSatisfyFullGpuHmr: false,
    can_satisfy_full_gpu_hmr: false,
    descriptorBytesHash,
    descriptor_bytes_hash: descriptorBytesHash,
    descriptorHash,
    descriptor_hash: descriptorHash,
    evidenceHash,
    evidence_hash: evidenceHash,
    inputSetHash,
    input_set_hash: inputSetHash,
    outputSetHash,
    output_set_hash: outputSetHash,
    artifactLocatorSetHash,
    artifact_locator_set_hash: artifactLocatorSetHash,
    artifactCount,
    artifact_count: artifactCount,
    failedGates,
    failed_gates: failedGates,
  };
}

export async function arbitraryColdProjectRunFacet(rawEnvelope = {}, options = {}) {
  const present = isPlainObject(rawEnvelope) && Object.keys(rawEnvelope).length > 0;
  if (!isPlainObject(options)) {
    return classification({
      present,
      accepted: false,
      failedGates: ['arbitrary_cold_project_run_options_invalid'],
    });
  }
  try {
    const validated = await validateEnvelope(rawEnvelope, options);
    return classification({ present: true, accepted: true, validated });
  } catch (error) {
    return classification({
      present,
      accepted: false,
      failedGates: [
        error instanceof FacetGateError
          ? error.gate
          : 'arbitrary_cold_project_run_validation_exception',
      ],
    });
  }
}

export const validateArbitraryColdProjectRunFacet = arbitraryColdProjectRunFacet;
export const validateGpuHmrArbitraryColdProjectRunFacet = arbitraryColdProjectRunFacet;
export const classifyArbitraryColdProjectRunEnvelope = arbitraryColdProjectRunFacet;
