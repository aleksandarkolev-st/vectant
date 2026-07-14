import { createHash } from 'node:crypto';

import {
  CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
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

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
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

function retainedOutputAccepted(output, expectedMetadata, expectedBinding) {
  const locator = output?.artifactLocator;
  const transport = locator?.transport;
  const transportEvidence = output?.transportEvidence;
  return exactKeys(output, OUTPUT_KEYS)
    && stableJson(output.metadata) === stableJson(expectedMetadata)
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
    && transport?.kind === expectedBinding.transportKind
    && TRANSPORT_KIND_PATTERN.test(transport?.kind ?? '')
    && transport.contentAddressed === true
    && transport.manifestOnly === true
    && transport.bytesEmbedded === false
    && locator.proofAuthority === 'transport_integrity_only'
    && locator.acceptedForGpuHmr === false
    && locator.gpuHmrSuccess === false
    && transportEvidence?.accepted === true
    && transportEvidence?.acceptedAsTransportEvidence === true
    && transportEvidence?.acceptedForGpuHmr === false
    && transportEvidence?.gpuHmrSuccess === false
    && transportEvidence?.proofAuthority === 'transport_integrity_only'
    && transportEvidence?.contentHash === locator.contentHash
    && transportEvidence?.artifactId === locator.artifactId
    && transportEvidence?.manifestHash === locator.manifestHash
    && transportEvidence?.transportKind === transport.kind
    && !containsForbiddenAuthorityClaim(output);
}

function envelopeMaterialAccepted(envelope) {
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
