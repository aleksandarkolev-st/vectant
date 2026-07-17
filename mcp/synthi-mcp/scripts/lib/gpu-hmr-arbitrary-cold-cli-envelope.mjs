import { createHash } from 'node:crypto';

import {
  CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
  GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
  casUriForHash,
  validateSharedArtifactAddressing,
} from './gpu-hmr-artifact-cas.mjs';
import {
  verifyArbitraryColdRetainedExecutionChain,
} from './gpu-hmr-arbitrary-cold-retained-chain.mjs';

export const ARBITRARY_COLD_CLI_RESULT_ENVELOPE_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_cli_result_envelope.v1';
export const ARBITRARY_COLD_CLI_RESULT_ENVELOPE_AUTHORITY =
  'serialized_cli_result_integrity_only_not_authenticity_or_gpu_hmr_success';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ARTIFACT_ID_PATTERN = /^artifact:sha256:[a-f0-9]{64}$/;
const TRANSPORT_KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const OUTPUT_KEYS = Object.freeze(['metadata', 'artifactLocator', 'transportEvidence']);
const OUTPUT_METADATA_KEYS = Object.freeze([
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
]);
const ARTIFACT_LOCATOR_KEYS = Object.freeze([
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
  'manifestHash',
]);
const ARTIFACT_LOCATOR_OPTIONAL_KEYS = Object.freeze([
  'storage',
  'sharedStorage',
  'shared_storage',
]);
const ARTIFACT_PRODUCER_KEYS = Object.freeze(['name', 'kind']);
const ARTIFACT_TRANSPORT_KEYS = Object.freeze([
  'kind',
  'contentAddressed',
  'manifestOnly',
  'bytesEmbedded',
  'hotPathOptimized',
]);
const ARTIFACT_STORAGE_KEYS = Object.freeze(['kind', 'relativePath']);
const ARTIFACT_STORAGE_OPTIONAL_KEYS = Object.freeze(['localPath']);
const SHARED_STORAGE_KEYS = Object.freeze([
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
]);
const SHARED_STORAGE_MOUNT_KEYS = Object.freeze([
  'role',
  'root',
  'path',
  'addressKind',
  'readableBytesProven',
]);
const SHARED_STORAGE_VALIDATION_KEYS = Object.freeze([
  'schemaVersion',
  'accepted',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'proofAuthority',
  'contentHash',
  'relativePath',
  'mountCount',
  'mountRoles',
  'reasons',
  'gaps',
]);
const TRANSPORT_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'accepted',
  'acceptedAsTransportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'proofAuthority',
  'manifestHash',
  'contentHash',
  'artifactId',
  'artifactUri',
  'transportKind',
  'byteLength',
  'mediaType',
  'reasons',
  'gaps',
]);
const TRANSPORT_EVIDENCE_OPTIONAL_KEYS = Object.freeze([
  'sharedStorage',
  'shared_storage',
  'sharedMountCount',
  'shared_mount_count',
  'sharedMountRoles',
  'shared_mount_roles',
  'localPath',
  'local_path',
]);
const ENVELOPE_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'descriptorBytesHash',
  'descriptorHash',
  'evidence',
  'retainedExecutionChain',
  'artifactSessionRootIdentityHash',
  'outputs',
  'outputBytesEmbedded',
  'externalAuthenticityAnchorEmbedded',
  'acceptedAsCliResultEnvelope',
  'acceptedAsColdBuildEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
]);
const FORBIDDEN_TRUE_AUTHORITY_KEYS = new Set([
  'acceptedascoldbuildevidence',
  'acceptedforgpuhmr',
  'gpuhmrsuccess',
  'cansatisfyruntimeproof',
  'cansatisfydispatchproof',
  'runtimeauthority',
  'dispatchauthority',
  'fullruntimeproven',
]);
const FORBIDDEN_BINARY_PAYLOAD_KEYS = new Set([
  'base64',
  'binary',
  'binarydata',
  'blob',
  'blobdata',
  'buffer',
  'bufferdata',
  'bytedata',
  'bytes',
  'data',
  'encodedbytes',
  'payload',
  'payloadbase64',
  'payloadbytes',
  'rawbytes',
  'rawdata',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function recomputeEvidenceHash(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isPlainRecord(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function exactOptionalKeys(value, requiredKeys, optionalKeys) {
  if (!isPlainRecord(value)) return false;
  const actualKeys = Object.keys(value);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && actualKeys.every((key) => allowedKeys.has(key));
}

function isForbiddenBinaryPayloadKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return FORBIDDEN_BINARY_PAYLOAD_KEYS.has(normalized)
    || normalized.includes('base64')
    || /^(?:artifact|content|file|output|raw)bytes$/.test(normalized)
    || /^(?:byte|binary|blob|buffer|data)payload$/.test(normalized);
}

function containsEmbeddedBinaryMaterial(value, seen = new Set()) {
  if (
    Buffer.isBuffer(value)
    || value instanceof ArrayBuffer
    || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)
    || ArrayBuffer.isView(value)
  ) {
    return true;
  }
  if (typeof value === 'string') {
    return /^data:[^,;]+(?:;[^,;]+)*;base64,/i.test(value);
  }
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) {
    const rejected = value.some((child) => containsEmbeddedBinaryMaterial(child, seen));
    seen.delete(value);
    return rejected;
  }
  if (!isPlainRecord(value)) {
    seen.delete(value);
    return true;
  }
  if (
    value.type === 'Buffer'
    && Array.isArray(value.data)
    && value.data.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
  ) {
    seen.delete(value);
    return true;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenBinaryPayloadKey(key) || containsEmbeddedBinaryMaterial(child, seen)) {
      seen.delete(value);
      return true;
    }
  }
  seen.delete(value);
  return false;
}

function byteOrder(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function supportFlagsAreFalse(value) {
  return value?.acceptedForGpuHmr === false
    && value?.gpuHmrSuccess === false
    && value?.canSatisfyRuntimeProof === false
    && value?.canSatisfyDispatchProof === false;
}

function containsForbiddenAuthorityClaim(value) {
  if (Array.isArray(value)) return value.some(containsForbiddenAuthorityClaim);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (child === true && FORBIDDEN_TRUE_AUTHORITY_KEYS.has(normalizedKey))
      || containsForbiddenAuthorityClaim(child);
  });
}

function locatorManifestHash(locator) {
  return contentHash(stableJson({ ...locator, manifestHash: undefined }));
}

function sharedStorageShapeAccepted(sharedStorage) {
  return exactKeys(sharedStorage, SHARED_STORAGE_KEYS)
    && Array.isArray(sharedStorage.mountRoles)
    && Array.isArray(sharedStorage.mounts)
    && sharedStorage.mounts.every((mount) => exactKeys(mount, SHARED_STORAGE_MOUNT_KEYS));
}

function sharedStorageValidationShapeAccepted(sharedStorage) {
  return exactKeys(sharedStorage, SHARED_STORAGE_VALIDATION_KEYS)
    && Array.isArray(sharedStorage.mountRoles)
    && Array.isArray(sharedStorage.reasons)
    && Array.isArray(sharedStorage.gaps);
}

function artifactLocatorShapeAccepted(locator) {
  if (
    !exactOptionalKeys(locator, ARTIFACT_LOCATOR_KEYS, ARTIFACT_LOCATOR_OPTIONAL_KEYS)
    || !exactKeys(locator.producer, ARTIFACT_PRODUCER_KEYS)
    || !exactKeys(locator.transport, ARTIFACT_TRANSPORT_KEYS)
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(locator.producer.name ?? '')
    || !/^[A-Za-z0-9._:-]{1,160}$/.test(locator.producer.kind ?? '')
  ) {
    return false;
  }
  const storagePresent = Object.hasOwn(locator, 'storage');
  if (storagePresent) {
    const storage = locator.storage;
    const localPathPresent = Object.hasOwn(storage, 'localPath');
    const relativePathAccepted = (
      typeof storage.relativePath === 'string' && storage.relativePath.length > 0
    ) || (storage.relativePath === null && localPathPresent);
    if (
      !exactOptionalKeys(storage, ARTIFACT_STORAGE_KEYS, ARTIFACT_STORAGE_OPTIONAL_KEYS)
      || storage.kind !== locator.transport.kind
      || !relativePathAccepted
      || (localPathPresent
        && (typeof storage.localPath !== 'string' || storage.localPath.length === 0))
    ) {
      return false;
    }
  }
  const sharedCamelPresent = Object.hasOwn(locator, 'sharedStorage');
  const sharedSnakePresent = Object.hasOwn(locator, 'shared_storage');
  return sharedCamelPresent === sharedSnakePresent
    && (!sharedCamelPresent || (
      stableJson(locator.sharedStorage) === stableJson(locator.shared_storage)
      && sharedStorageShapeAccepted(locator.sharedStorage)
      && sharedStorageShapeAccepted(locator.shared_storage)
    ));
}

function transportEvidenceShapeAccepted(locator, evidence) {
  if (!exactOptionalKeys(
    evidence,
    TRANSPORT_EVIDENCE_KEYS,
    TRANSPORT_EVIDENCE_OPTIONAL_KEYS,
  )) {
    return false;
  }
  const locatorHasSharedStorage = Object.hasOwn(locator, 'sharedStorage');
  const sharedEvidenceKeys = [
    'sharedStorage',
    'shared_storage',
    'sharedMountCount',
    'shared_mount_count',
    'sharedMountRoles',
    'shared_mount_roles',
  ];
  const sharedEvidencePresent = sharedEvidenceKeys.map((key) => Object.hasOwn(evidence, key));
  if (
    sharedEvidencePresent.some(Boolean) !== locatorHasSharedStorage
    || (locatorHasSharedStorage && !sharedEvidencePresent.every(Boolean))
  ) {
    return false;
  }
  if (locatorHasSharedStorage && (
    !sharedStorageValidationShapeAccepted(evidence.sharedStorage)
    || !sharedStorageValidationShapeAccepted(evidence.shared_storage)
    || stableJson(evidence.sharedStorage) !== stableJson(evidence.shared_storage)
  )) {
    return false;
  }
  const locatorHasLocalPath = typeof locator.storage?.localPath === 'string'
    && locator.storage.localPath.length > 0;
  const localPathKeysPresent = ['localPath', 'local_path']
    .map((key) => Object.hasOwn(evidence, key));
  return localPathKeysPresent.some(Boolean) === locatorHasLocalPath
    && (!locatorHasLocalPath || localPathKeysPresent.every(Boolean));
}

function transportEvidenceBindingAccepted(locator, evidence) {
  const transport = locator?.transport;
  const expectedGaps = transport?.kind === 'serialized_fallback'
    ? ['serialized_artifact_transport_fallback']
    : [];
  const sharedInput = locator?.sharedStorage ?? locator?.shared_storage ?? null;
  if (sharedInput !== null) {
    const shared = validateSharedArtifactAddressing(sharedInput, {
      expectedContentHash: locator.contentHash,
      expectedRelativePath: locator.storage?.relativePath,
      transportKind: transport?.kind,
    });
    if (
      shared.accepted !== true
      || stableJson(locator.sharedStorage) !== stableJson(locator.shared_storage)
      || stableJson(evidence?.sharedStorage) !== stableJson(shared)
      || stableJson(evidence?.shared_storage) !== stableJson(shared)
      || evidence.sharedMountCount !== shared.mountCount
      || evidence.shared_mount_count !== shared.mountCount
      || stableJson(evidence.sharedMountRoles) !== stableJson(shared.mountRoles)
      || stableJson(evidence.shared_mount_roles) !== stableJson(shared.mountRoles)
    ) {
      return false;
    }
    expectedGaps.push(...shared.gaps);
  } else if ([
    'sharedStorage',
    'shared_storage',
    'sharedMountCount',
    'shared_mount_count',
    'sharedMountRoles',
    'shared_mount_roles',
  ].some((name) => Object.hasOwn(evidence ?? {}, name))) {
    return false;
  }
  const localPath = locator?.storage?.localPath;
  if (localPath) {
    if (evidence?.localPath !== localPath || evidence?.local_path !== localPath) {
      return false;
    }
  } else if (
    Object.hasOwn(evidence ?? {}, 'localPath')
    || Object.hasOwn(evidence ?? {}, 'local_path')
  ) {
    return false;
  }
  return evidence?.schemaVersion === GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION
    && evidence.accepted === true
    && evidence.acceptedAsTransportEvidence === true
    && evidence.acceptedForGpuHmr === false
    && evidence.gpuHmrSuccess === false
    && evidence.proofAuthority === 'transport_integrity_only'
    && evidence.contentHash === locator.contentHash
    && evidence.artifactId === locator.artifactId
    && evidence.artifactUri === locator.artifactUri
    && evidence.manifestHash === locator.manifestHash
    && evidence.transportKind === transport.kind
    && evidence.byteLength === locator.byteLength
    && evidence.mediaType === locator.mediaType
    && Array.isArray(evidence.reasons)
    && evidence.reasons.length === 0
    && Array.isArray(evidence.gaps)
    && stableJson(evidence.gaps) === stableJson(expectedGaps);
}

function canonicalLocatorUriAccepted(locator) {
  try {
    return locator?.artifactUri === casUriForHash(locator.contentHash, {
      sessionNamespace: locator.sessionNamespace,
    });
  } catch {
    return false;
  }
}

function retainedOutputAccepted(output, expectedMetadata, expectedBinding) {
  const locator = output?.artifactLocator;
  const transport = locator?.transport;
  const transportEvidence = output?.transportEvidence;
  return exactKeys(output, OUTPUT_KEYS)
    && exactKeys(output.metadata, OUTPUT_METADATA_KEYS)
    && stableJson(output.metadata) === stableJson(expectedMetadata)
    && artifactLocatorShapeAccepted(locator)
    && transportEvidenceShapeAccepted(locator, transportEvidence)
    && locator?.schemaVersion === CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION
    && SHA256_PATTERN.test(locator?.contentHash ?? '')
    && locator.contentHash === expectedBinding.contentHash
    && Number.isSafeInteger(locator.byteLength)
    && locator.byteLength === expectedBinding.byteLength
    && ARTIFACT_ID_PATTERN.test(locator.artifactId ?? '')
    && locator.artifactId === expectedBinding.artifactId
    && locator.artifactId === `artifact:${locator.contentHash}`
    && SHA256_PATTERN.test(locator.manifestHash ?? '')
    && locator.manifestHash === expectedBinding.manifestHash
    && locator.manifestHash === locatorManifestHash(locator)
    && locator.artifactKind === 'cold_build_artifact'
    && locator.mediaType === expectedMetadata.declaredMediaType
    && locator.role === 'cold_build_output'
    && canonicalLocatorUriAccepted(locator)
    && transport?.kind === expectedBinding.transportKind
    && TRANSPORT_KIND_PATTERN.test(transport?.kind ?? '')
    && transport.contentAddressed === true
    && transport.manifestOnly === true
    && transport.bytesEmbedded === false
    && locator.proofAuthority === 'transport_integrity_only'
    && locator.acceptedForGpuHmr === false
    && locator.gpuHmrSuccess === false
    && transportEvidenceBindingAccepted(locator, transportEvidence)
    && !containsForbiddenAuthorityClaim(output);
}

function envelopeMaterialAccepted(envelope) {
  if (containsEmbeddedBinaryMaterial(envelope)) return false;
  const chain = envelope?.retainedExecutionChain;
  try {
    verifyArbitraryColdRetainedExecutionChain(chain);
  } catch {
    return false;
  }
  const expectedMetadata = [...chain.outputEvidenceReceipt.outputEvidence.outputs]
    .sort((left, right) => byteOrder(left.path, right.path));
  const expectedBindings = [...chain.artifactLocatorBindings]
    .sort((left, right) => byteOrder(left.path, right.path));
  const outputs = envelope.outputs;
  return exactKeys(envelope, ENVELOPE_KEYS)
    && envelope.schemaVersion === ARBITRARY_COLD_CLI_RESULT_ENVELOPE_SCHEMA
    && envelope.proofAuthority === ARBITRARY_COLD_CLI_RESULT_ENVELOPE_AUTHORITY
    && SHA256_PATTERN.test(envelope.descriptorBytesHash ?? '')
    && envelope.descriptorHash === chain.descriptorHash
    && stableJson(envelope.evidence) === stableJson(chain.runEvidence)
    && envelope.artifactSessionRootIdentityHash
      === chain.runEvidence.artifactSessionRootIdentityHash
    && Array.isArray(outputs)
    && outputs.length === expectedMetadata.length
    && outputs.length === expectedBindings.length
    && outputs.every((output, index) => (
      output?.metadata?.path === expectedMetadata[index].path
      && output.metadata.path === expectedBindings[index].path
      && retainedOutputAccepted(output, expectedMetadata[index], expectedBindings[index])
    ))
    && envelope.outputBytesEmbedded === false
    && envelope.externalAuthenticityAnchorEmbedded === false
    && envelope.acceptedAsCliResultEnvelope === true
    && envelope.acceptedAsColdBuildEvidence === false
    && supportFlagsAreFalse(envelope)
    && SHA256_PATTERN.test(envelope.evidenceHash ?? '')
    && envelope.evidenceHash === recomputeEvidenceHash(envelope);
}

export function createArbitraryColdCliResultEnvelope({
  descriptorBytesHash,
  result,
} = {}) {
  const envelope = {
    schemaVersion: ARBITRARY_COLD_CLI_RESULT_ENVELOPE_SCHEMA,
    proofAuthority: ARBITRARY_COLD_CLI_RESULT_ENVELOPE_AUTHORITY,
    descriptorBytesHash,
    descriptorHash: result?.evidence?.descriptorHash,
    evidence: structuredClone(result?.evidence),
    retainedExecutionChain: structuredClone(result?.retainedExecutionChain),
    artifactSessionRootIdentityHash: result?.evidence?.artifactSessionRootIdentityHash,
    outputs: (result?.outputs ?? []).map((output) => ({
      metadata: structuredClone(output.metadata),
      artifactLocator: structuredClone(output.artifactLocator),
      transportEvidence: structuredClone(output.transportEvidence),
    })).sort((left, right) => byteOrder(left.metadata?.path ?? '', right.metadata?.path ?? '')),
    outputBytesEmbedded: false,
    externalAuthenticityAnchorEmbedded: false,
    acceptedAsCliResultEnvelope: true,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  envelope.evidenceHash = recomputeEvidenceHash(envelope);
  if (!envelopeMaterialAccepted(envelope)) {
    throw new Error('arbitrary_cold_cli_result_envelope_source_invalid');
  }
  return envelope;
}

export function verifyArbitraryColdCliResultEnvelope(envelope) {
  if (!envelopeMaterialAccepted(envelope)) {
    throw new Error('arbitrary_cold_cli_result_envelope_invalid');
  }
  return envelope;
}
