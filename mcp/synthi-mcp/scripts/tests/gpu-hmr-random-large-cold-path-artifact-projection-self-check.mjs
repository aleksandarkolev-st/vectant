import assert from 'node:assert/strict';

import {
  buildArtifactCasManifest,
  sha256Text,
  stableJson,
  validateArtifactCasManifest,
} from '../lib/gpu-hmr-artifact-cas.mjs';
import {
  projectStaticArbitraryColdArtifactLocators,
} from '../gpu-hmr-random-large-project-cold-path.mjs';

const bytes = Buffer.from('generic cold build output bytes\n');
const artifactLocator = await buildArtifactCasManifest({
  bytes,
  artifactKind: 'cold_build_artifact',
  mediaType: 'application/octet-stream',
  role: 'cold_build_output',
  producer: { name: 'arbitrary_cold_project_runner', kind: 'cold_build' },
  producerSubsystem: 'gpu_hmr_cold_path',
  sessionNamespace: 'cold-projection-self-check',
  transportKind: 'cas_shared_volume',
  portable: true,
});
const transportEvidence = await validateArtifactCasManifest(artifactLocator);
assert.equal(transportEvidence.acceptedAsTransportEvidence, true);

const metadata = {
  path: 'build/output.bin',
  declaredRole: 'build_output',
  declaredArtifactKind: 'opaque_build_output',
  declaredMediaType: 'application/octet-stream',
  declaredContentHash: artifactLocator.contentHash,
  declaredByteLength: artifactLocator.byteLength,
  observedContentHash: artifactLocator.contentHash,
  observedByteLength: artifactLocator.byteLength,
  mode: 0o644,
  metadataAuthority: 'advisory_only_not_output_acceptance',
};
const rawPayload = Buffer.from('must never enter retained JSON');
const base64Payload = rawPayload.toString('base64');
const projected = projectStaticArbitraryColdArtifactLocators([{
  metadata,
  artifactLocator,
  transportEvidence,
  bytes: rawPayload,
  base64Payload,
  nestedPayload: { bytes: Buffer.from(rawPayload) },
}], {
  expectedLocatorSetHash: sha256Text(stableJson([{
    path: metadata.path,
    contentHash: metadata.observedContentHash,
    byteLength: metadata.observedByteLength,
    artifactId: artifactLocator.artifactId,
    manifestHash: artifactLocator.manifestHash,
    transportKind: artifactLocator.transport.kind,
  }])),
});

assert.match(projected.artifactLocatorSetHash, /^sha256:[a-f0-9]{64}$/);
assert.match(projected.artifactLocatorProjectionHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(projected.artifactLocators.length, 1);
const retained = projected.artifactLocators[0];
assert.deepEqual(Object.keys(retained).sort(), [
  'acceptedForGpuHmr',
  'artifactLocator',
  'canSatisfyDispatchProof',
  'canSatisfyRuntimeProof',
  'gpuHmrSuccess',
  'metadata',
  'projectionHash',
  'proofAuthority',
  'schemaVersion',
  'transportEvidence',
  'transportEvidenceProjectionHash',
].sort());
assert.equal(retained.acceptedForGpuHmr, false);
assert.equal(retained.gpuHmrSuccess, false);
assert.equal(retained.canSatisfyRuntimeProof, false);
assert.equal(retained.canSatisfyDispatchProof, false);
assert.equal(retained.artifactLocator.transport.manifestOnly, true);
assert.equal(retained.artifactLocator.transport.bytesEmbedded, false);
assert.equal(retained.transportEvidence.acceptedForGpuHmr, false);
assert.equal(retained.transportEvidence.gpuHmrSuccess, false);

const retainedJson = JSON.stringify(projected);
assert.equal(retainedJson.includes(base64Payload), false);
assert.equal(retainedJson.includes('must never enter retained JSON'), false);
assert.equal(retainedJson.includes('"type":"Buffer"'), false);
assert.equal(retainedJson.includes('"bytes"'), false);
assert.equal(retainedJson.includes('"base64Payload"'), false);

assert.throws(
  () => projectStaticArbitraryColdArtifactLocators([{
    metadata: { ...metadata, payload: base64Payload },
    artifactLocator,
    transportEvidence,
    bytes,
  }]),
  /metadata_shape_refused|embedded_bytes_refused/,
);
assert.throws(
  () => projectStaticArbitraryColdArtifactLocators([{
    metadata,
    artifactLocator: { ...artifactLocator, bytes: rawPayload },
    transportEvidence,
    bytes,
  }]),
  /embedded_bytes_refused|locator_shape_refused/,
);
assert.throws(
  () => projectStaticArbitraryColdArtifactLocators([{
    metadata,
    artifactLocator,
    transportEvidence: { ...transportEvidence, acceptedForGpuHmr: true },
    bytes,
  }]),
  /transport_evidence_refused/,
);

console.log('random large cold-path manifest-only artifact projection self-check passed');
