import { createHash } from 'node:crypto';
import path from 'node:path';

import { COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH } from './gpu-hmr-cold-build-container-contract.mjs';
import { verifyColdBuildExecutionDriverResult } from './gpu-hmr-cold-build-execution-driver.mjs';

export const COLD_BUILD_OUTPUT_EVIDENCE_SCHEMA =
  'synthi.gpu_hmr.cold_build_output_evidence.v2';
export const COLD_BUILD_OUTPUT_EVIDENCE_AUTHORITY =
  'recomputed_collector_output_bytes_only_not_gpu_hmr_success';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const OUTPUT_MANIFEST_SCHEMA = 'synthi.gpu_hmr.cold_build_output_manifest.v1';
const PINNED_OUTPUT_RESULTS = new WeakMap();

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

function recomputeEvidenceHash(evidence) {
  const projection = { ...evidence };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function normalizeRelativeOutputPath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\\\0\r\n]/.test(value)) {
    throw new Error('cold_build_output_evidence_path_invalid');
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
  ) {
    throw new Error('cold_build_output_evidence_path_invalid');
  }
  return normalized;
}

function parseOutputManifest(bytes, plan) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('cold_build_output_evidence_manifest_json_invalid');
  }
  if (
    !exactKeys(manifest, [
      'schemaVersion',
      'commandSpecHash',
      'sourceBindingHash',
      'acceptedForGpuHmr',
      'gpuHmrSuccess',
      'canSatisfyRuntimeProof',
      'outputs',
    ])
    || manifest.schemaVersion !== OUTPUT_MANIFEST_SCHEMA
    || manifest.commandSpecHash !== plan.commandSpecHash
    || manifest.sourceBindingHash !== plan.sourceBindingHash
    || manifest.acceptedForGpuHmr !== false
    || manifest.gpuHmrSuccess !== false
    || manifest.canSatisfyRuntimeProof !== false
    || !Array.isArray(manifest.outputs)
    || manifest.outputs.length < 1
    || manifest.outputs.length > plan.resourcePolicy.collectedEntryLimit - 1
  ) {
    throw new Error('cold_build_output_evidence_manifest_invalid');
  }
  return manifest;
}

function normalizedOutputDeclaration(output) {
  if (
    !exactKeys(output, [
      'path',
      'role',
      'artifactKind',
      'mediaType',
      'contentHash',
      'byteLength',
    ])
    || typeof output.role !== 'string'
    || output.role.length === 0
    || /[\0\r\n]/.test(output.role)
    || typeof output.artifactKind !== 'string'
    || output.artifactKind.length === 0
    || /[\0\r\n]/.test(output.artifactKind)
    || typeof output.mediaType !== 'string'
    || output.mediaType.length === 0
    || /[\0\r\n]/.test(output.mediaType)
    || !HASH_PATTERN.test(output.contentHash ?? '')
    || !Number.isSafeInteger(output.byteLength)
    || output.byteLength < 0
  ) {
    throw new Error('cold_build_output_evidence_declaration_invalid');
  }
  return {
    path: normalizeRelativeOutputPath(output.path),
    declaredRole: output.role,
    declaredArtifactKind: output.artifactKind,
    declaredMediaType: output.mediaType,
    declaredContentHash: output.contentHash,
    declaredByteLength: output.byteLength,
  };
}

function buildOutputProjection(driverResult, plan) {
  verifyColdBuildExecutionDriverResult(driverResult, plan);
  const payloadByPath = new Map();
  for (const payload of driverResult.payloads) {
    const payloadPath = normalizeRelativeOutputPath(payload.entry.path);
    if (payloadByPath.has(payloadPath)) {
      throw new Error('cold_build_output_evidence_payload_duplicate');
    }
    payloadByPath.set(payloadPath, payload);
  }
  const manifestPayload = payloadByPath.get(COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH);
  if (!manifestPayload) {
    throw new Error('cold_build_output_evidence_manifest_missing');
  }
  const manifest = parseOutputManifest(manifestPayload.bytes, plan);
  const seenDeclarations = new Set();
  const outputs = manifest.outputs.map((output) => {
    const declaration = normalizedOutputDeclaration(output);
    if (
      declaration.path === COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH
      || seenDeclarations.has(declaration.path)
    ) {
      throw new Error('cold_build_output_evidence_declaration_duplicate');
    }
    seenDeclarations.add(declaration.path);
    const payload = payloadByPath.get(declaration.path);
    if (
      !payload
      || payload.bytes.byteLength !== declaration.declaredByteLength
      || contentHash(payload.bytes) !== declaration.declaredContentHash
      || payload.entry.byteLength !== declaration.declaredByteLength
      || payload.entry.contentHash !== declaration.declaredContentHash
    ) {
      throw new Error('cold_build_output_evidence_payload_binding_invalid');
    }
    return {
      ...declaration,
      observedContentHash: contentHash(payload.bytes),
      observedByteLength: payload.bytes.byteLength,
      mode: payload.entry.mode,
      metadataAuthority: 'advisory_only_not_output_acceptance',
    };
  }).sort((left, right) => Buffer.compare(
    Buffer.from(left.path),
    Buffer.from(right.path),
  ));
  const expectedPayloadPaths = [
    COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH,
    ...outputs.map((output) => output.path),
  ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const observedPayloadPaths = [...payloadByPath.keys()].sort((left, right) => (
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  ));
  if (stableJson(expectedPayloadPaths) !== stableJson(observedPayloadPaths)) {
    throw new Error('cold_build_output_evidence_undeclared_payload');
  }
  return {
    manifest,
    manifestContentHash: contentHash(manifestPayload.bytes),
    manifestByteLength: manifestPayload.bytes.byteLength,
    outputs,
  };
}

export function deriveColdBuildOutputEvidence(driverResult, plan) {
  const projection = buildOutputProjection(driverResult, plan);
  const evidence = {
    schemaVersion: COLD_BUILD_OUTPUT_EVIDENCE_SCHEMA,
    proofAuthority: COLD_BUILD_OUTPUT_EVIDENCE_AUTHORITY,
    driverExecutionEvidenceHash: driverResult.evidence.evidenceHash,
    planHash: plan.planHash,
    executionNonce: plan.executionNonce,
    commandSpecHash: plan.commandSpecHash,
    sourceBindingHash: plan.sourceBindingHash,
    outputManifestSchemaVersion: projection.manifest.schemaVersion,
    outputManifestContentHash: projection.manifestContentHash,
    outputManifestByteLength: projection.manifestByteLength,
    outputs: projection.outputs,
    outputCount: projection.outputs.length,
    outputSetHash: contentHash(stableJson(projection.outputs)),
    declarationMetadataAuthority: 'advisory_only_not_output_acceptance',
    acceptedAsColdBuildOutputEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = recomputeEvidenceHash(evidence);
  const result = {
    evidence,
    outputs: projection.outputs.map((output) => {
      const payload = driverResult.payloads.find(({ entry }) => entry.path === output.path);
      return {
        metadata: { ...output },
        bytes: Buffer.from(payload.bytes),
      };
    }),
  };
  PINNED_OUTPUT_RESULTS.set(result, Object.freeze({
    driverResult,
    plan,
    evidenceHash: evidence.evidenceHash,
    outputSetHash: evidence.outputSetHash,
  }));
  return result;
}

export function verifyColdBuildOutputEvidence(result, driverResult, plan) {
  const pinned = PINNED_OUTPUT_RESULTS.get(result);
  let recomputed;
  try {
    recomputed = buildOutputProjection(driverResult, plan);
  } catch {
    throw new Error('cold_build_output_evidence_result_invalid');
  }
  const evidence = result?.evidence;
  const resultOutputs = result?.outputs;
  const recomputedOutputs = recomputed.outputs;
  const resultOutputProjection = Array.isArray(resultOutputs)
    ? resultOutputs.map(({ metadata, bytes }) => ({
      metadata,
      byteLength: Buffer.isBuffer(bytes) ? bytes.byteLength : null,
      contentHash: Buffer.isBuffer(bytes) ? contentHash(bytes) : null,
    }))
    : null;
  const expectedResultProjection = recomputedOutputs.map((metadata) => ({
    metadata,
    byteLength: metadata.observedByteLength,
    contentHash: metadata.observedContentHash,
  }));
  if (
    !pinned
    || pinned.driverResult !== driverResult
    || pinned.plan !== plan
    || pinned.evidenceHash !== evidence?.evidenceHash
    || pinned.outputSetHash !== evidence?.outputSetHash
    || evidence?.schemaVersion !== COLD_BUILD_OUTPUT_EVIDENCE_SCHEMA
    || evidence?.proofAuthority !== COLD_BUILD_OUTPUT_EVIDENCE_AUTHORITY
    || evidence?.driverExecutionEvidenceHash !== driverResult?.evidence?.evidenceHash
    || evidence?.planHash !== plan?.planHash
    || evidence?.executionNonce !== plan?.executionNonce
    || evidence?.commandSpecHash !== plan?.commandSpecHash
    || evidence?.sourceBindingHash !== plan?.sourceBindingHash
    || evidence?.outputManifestContentHash !== recomputed.manifestContentHash
    || evidence?.outputManifestByteLength !== recomputed.manifestByteLength
    || stableJson(evidence?.outputs) !== stableJson(recomputedOutputs)
    || evidence?.outputCount !== recomputedOutputs.length
    || evidence?.outputSetHash !== contentHash(stableJson(recomputedOutputs))
    || evidence?.declarationMetadataAuthority !== 'advisory_only_not_output_acceptance'
    || evidence?.acceptedAsColdBuildOutputEvidence !== true
    || evidence?.acceptedForGpuHmr !== false
    || evidence?.gpuHmrSuccess !== false
    || evidence?.canSatisfyRuntimeProof !== false
    || evidence?.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(evidence) !== evidence?.evidenceHash
    || stableJson(resultOutputProjection) !== stableJson(expectedResultProjection)
  ) {
    throw new Error('cold_build_output_evidence_result_invalid');
  }
  return result;
}
