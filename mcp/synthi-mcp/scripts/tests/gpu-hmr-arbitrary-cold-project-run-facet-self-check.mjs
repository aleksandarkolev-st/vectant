import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  sha256Bytes,
  sha256Text,
  stableJson,
  validateArtifactCasManifest,
  writeArtifactToCas,
} from '../lib/gpu-hmr-artifact-cas.mjs';
import {
  ARBITRARY_COLD_PROJECT_RUN_AUTHORITY,
  ARBITRARY_COLD_PROJECT_RUN_FACET_PROOF_MODE,
  ARBITRARY_COLD_PROJECT_RUN_SCHEMA,
  arbitraryColdProjectRunFacet,
} from '../lib/gpu-hmr-arbitrary-cold-project-run-facet.mjs';
import { createColdBuildInputSet } from '../lib/gpu-hmr-cold-build-input-set.mjs';

function canonicalHash(value) {
  return sha256Text(stableJson(value));
}

function opaqueHash(label) {
  return sha256Text(`opaque:${label}`);
}

function recomputeEvidenceHash(evidence) {
  const projection = { ...evidence };
  delete projection.evidenceHash;
  return canonicalHash(projection);
}

function refreshEvidenceHash(envelope) {
  envelope.evidence.evidenceHash = recomputeEvidenceHash(envelope.evidence);
  return envelope;
}

function pathIdentityHash(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return sha256Text(process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}

function locatorProjection(outputs) {
  return outputs.map((output) => ({
    path: output.metadata.path,
    contentHash: output.metadata.observedContentHash,
    byteLength: output.metadata.observedByteLength,
    artifactId: output.artifactLocator.artifactId,
    manifestHash: output.artifactLocator.manifestHash,
    transportKind: output.artifactLocator.transport.kind,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
}

function outputContractProjection(outputs) {
  return outputs.map((output) => ({
    path: output.metadata.path,
    declaredRole: output.metadata.declaredRole,
    declaredArtifactKind: output.metadata.declaredArtifactKind,
    declaredMediaType: output.metadata.declaredMediaType,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
}

async function createOutput(sessionRoot, planHash, bytes) {
  const contentHash = sha256Bytes(bytes);
  const metadata = {
    path: 'artifact.bin',
    declaredRole: 'compiled_output',
    declaredArtifactKind: 'binary_output',
    declaredMediaType: 'application/octet-stream',
    declaredContentHash: contentHash,
    declaredByteLength: bytes.byteLength,
    observedContentHash: contentHash,
    observedByteLength: bytes.byteLength,
    mode: 0o640,
    metadataAuthority: 'advisory_only_not_output_acceptance',
  };
  const artifactLocator = await writeArtifactToCas(bytes, {
    artifactRoot: sessionRoot,
    artifactKind: 'cold_build_artifact',
    mediaType: metadata.declaredMediaType,
    role: 'cold_build_output',
    producer: { name: 'arbitrary_cold_project_runner', kind: 'cold_build' },
    producerSubsystem: 'gpu_hmr_cold_path',
    sessionNamespace:
      `cold-${planHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    includeLocalPath: true,
    sharedCasMounts: [],
  });
  const transportEvidence = await validateArtifactCasManifest(artifactLocator, {
    allowedRoots: [sessionRoot],
  });
  assert.equal(transportEvidence.accepted, true);
  return { metadata, artifactLocator, transportEvidence };
}

async function createFixture(root) {
  const trustedRoot = path.join(root, 'trusted-cas');
  await mkdir(trustedRoot);
  const sessionRoot = await mkdtemp(path.join(trustedRoot, 'cold-run-'));
  const canonicalSessionRoot = await realpath(sessionRoot);
  const descriptorBytes = Buffer.from(JSON.stringify({
    schemaVersion: 'opaque-descriptor-input',
    command: '/workspace/source/build.sh',
  }), 'utf8');
  const sourceBindingHash = opaqueHash('source-binding');
  const readOnlyInputBindings = [{
    mountPath: 'dependency-input',
    sourceBindingHash: opaqueHash('read-only-source-binding'),
    sourceTreeBindingEvidenceHash: opaqueHash('read-only-tree-evidence'),
    entryCount: 3,
    totalByteLength: 91,
  }];
  const readOnlyInputSnapshotBindings = [{
    mountPath: readOnlyInputBindings[0].mountPath,
    snapshotEvidenceHash: opaqueHash('read-only-snapshot-evidence'),
  }];
  const inputSet = createColdBuildInputSet({
    sourceBindingHash,
    readOnlyInputs: readOnlyInputBindings.map(({ mountPath, sourceBindingHash: hash }) => ({
      mountPath,
      sourceBindingHash: hash,
    })),
  });
  const planHash = opaqueHash('plan');
  const outputBytes = Buffer.from('verified output bytes\n', 'utf8');
  const outputs = [await createOutput(canonicalSessionRoot, planHash, outputBytes)];
  const metadata = outputs.map((output) => output.metadata);
  const evidence = {
    schemaVersion: ARBITRARY_COLD_PROJECT_RUN_SCHEMA,
    proofAuthority: ARBITRARY_COLD_PROJECT_RUN_AUTHORITY,
    descriptorHash: opaqueHash('normalized-descriptor'),
    sourcePathIdentityHash: opaqueHash('source-path-identity'),
    sourceBindingHash,
    sourceTreeBindingEvidenceHash: opaqueHash('source-tree-evidence'),
    sourceSnapshotEvidenceHash: opaqueHash('source-snapshot-evidence'),
    inputSetBindings: inputSet.entries,
    inputSetHash: inputSet.inputSetHash,
    readOnlyInputBindings,
    readOnlyInputBindingSetHash: canonicalHash(readOnlyInputBindings),
    readOnlyInputSnapshotBindings,
    readOnlyInputSnapshotSetHash: canonicalHash(readOnlyInputSnapshotBindings),
    readOnlyInputCount: readOnlyInputBindings.length,
    readOnlyInputEntryCount: readOnlyInputBindings.reduce(
      (total, binding) => total + binding.entryCount,
      0,
    ),
    readOnlyInputByteLength: readOnlyInputBindings.reduce(
      (total, binding) => total + binding.totalByteLength,
      0,
    ),
    workerImageEvidenceHash: opaqueHash('worker-image-evidence'),
    workerImageId: opaqueHash('worker-image'),
    contractHash: opaqueHash('contract'),
    commandSpecHash: opaqueHash('command-spec'),
    launcherExecutableHash: opaqueHash('launcher-executable'),
    planHash,
    driverExecutionEvidenceHash: opaqueHash('driver-execution-evidence'),
    outputEvidenceHash: opaqueHash('output-evidence'),
    outputSetHash: canonicalHash(metadata),
    outputContractHash: canonicalHash(outputContractProjection(outputs)),
    artifactSessionRootIdentityHash: pathIdentityHash(canonicalSessionRoot),
    artifactLocatorSetHash: canonicalHash(locatorProjection(outputs)),
    artifactCount: outputs.length,
    timings: {
      metricClock: 'monotonic_ns',
      metricScope: 'cold',
      artifactRootValidationNanos: 1,
      imageInspectionNanos: 2,
      sourceBindingNanos: 3,
      readOnlyInputBindingNanos: 4,
      launcherMaterializationNanos: 5,
      executionNanos: 6,
      outputEvidenceNanos: 7,
      artifactPersistenceNanos: 8,
      totalRunnerWallNanos: 40,
    },
    coldBuildSucceeded: true,
    acceptedAsColdBuildEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = recomputeEvidenceHash(evidence);
  return {
    trustedRoot,
    sessionRoot: canonicalSessionRoot,
    descriptorBytes,
    outputBytes,
    envelope: {
      descriptorBytesHash: sha256Bytes(descriptorBytes),
      evidence,
      outputs,
    },
  };
}

async function requireRefusal(envelope, trustedRoot, expectedGate) {
  const result = await arbitraryColdProjectRunFacet(envelope, {
    trustedCasRoots: [trustedRoot],
  });
  assert.equal(result.accepted, false);
  assert.equal(result.acceptedAsSupportEvidence, false);
  assert.equal(result.acceptedForGpuHmr, false);
  assert.equal(result.gpuHmrSuccess, false);
  assert.equal(result.canSatisfyRuntimeProof, false);
  assert.equal(result.canSatisfyDispatchProof, false);
  assert.equal(result.canSatisfyFullGpuHmr, false);
  assert.match(result.failedGates[0], expectedGate);
  return result;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-arbitrary-cold-run-facet-'));
try {
  const fixture = await createFixture(root);
  const valid = await arbitraryColdProjectRunFacet(fixture.envelope, {
    trustedCasRoots: [fixture.trustedRoot],
    descriptorBytes: fixture.descriptorBytes,
  });
  assert.equal(valid.present, true);
  assert.equal(valid.accepted, true);
  assert.equal(valid.matrixRecomputed, true);
  assert.equal(valid.proofMode, ARBITRARY_COLD_PROJECT_RUN_FACET_PROOF_MODE);
  assert.equal(valid.proofAuthority, ARBITRARY_COLD_PROJECT_RUN_AUTHORITY);
  assert.equal(valid.authorityScope, 'support_only');
  assert.equal(valid.supportOnly, true);
  assert.equal(valid.acceptedAsSupportEvidence, true);
  assert.equal(valid.acceptedAsColdBuildEvidence, true);
  assert.equal(valid.coldBuildSucceeded, true);
  assert.equal(valid.acceptedForGpuHmr, false);
  assert.equal(valid.gpuHmrSuccess, false);
  assert.equal(valid.canSatisfyRuntimeProof, false);
  assert.equal(valid.canSatisfyDispatchProof, false);
  assert.equal(valid.canSatisfyFullGpuHmr, false);
  assert.deepEqual(valid.failedGates, []);
  assert.equal(valid.evidenceHash, fixture.envelope.evidence.evidenceHash);
  assert.equal(valid.inputSetHash, fixture.envelope.evidence.inputSetHash);
  assert.equal(valid.outputSetHash, fixture.envelope.evidence.outputSetHash);

  const noRoots = await arbitraryColdProjectRunFacet(fixture.envelope);
  assert.equal(noRoots.accepted, false);
  assert.match(noRoots.failedGates[0], /trusted_roots_required/);

  for (const flag of [
    'acceptedForGpuHmr',
    'gpuHmrSuccess',
    'canSatisfyRuntimeProof',
    'canSatisfyDispatchProof',
  ]) {
    const forgedAuthority = structuredClone(fixture.envelope);
    forgedAuthority.evidence[flag] = true;
    refreshEvidenceHash(forgedAuthority);
    await requireRefusal(forgedAuthority, fixture.trustedRoot, /authority_claim|authority_flags/);
  }

  const staleEvidence = structuredClone(fixture.envelope);
  staleEvidence.evidence.workerImageEvidenceHash = opaqueHash('changed-worker-image-evidence');
  await requireRefusal(staleEvidence, fixture.trustedRoot, /evidence_hash_mismatch/);

  const mismatchedInputSet = structuredClone(fixture.envelope);
  mismatchedInputSet.evidence.inputSetHash = opaqueHash('mismatched-input-set');
  refreshEvidenceHash(mismatchedInputSet);
  await requireRefusal(mismatchedInputSet, fixture.trustedRoot, /input_set_hash_mismatch/);

  const casPath = fixture.envelope.outputs[0].artifactLocator.storage.localPath;
  await writeFile(casPath, Buffer.alloc(fixture.outputBytes.byteLength, 0x78));
  await requireRefusal(fixture.envelope, fixture.trustedRoot, /output_cas_hash_mismatch/);
  await writeFile(casPath, fixture.outputBytes);

  await writeFile(casPath, Buffer.concat([fixture.outputBytes, Buffer.from([0])]));
  await requireRefusal(fixture.envelope, fixture.trustedRoot, /output_cas_byte_length_mismatch/);
  await writeFile(casPath, fixture.outputBytes);

  const untrustedRoot = path.join(root, 'untrusted-cas');
  await mkdir(untrustedRoot);
  const untrustedSession = await mkdtemp(path.join(untrustedRoot, 'cold-run-'));
  const escapedOutput = await createOutput(
    await realpath(untrustedSession),
    fixture.envelope.evidence.planHash,
    fixture.outputBytes,
  );
  const escapedPath = structuredClone(fixture.envelope);
  escapedPath.outputs = [escapedOutput];
  escapedPath.evidence.artifactSessionRootIdentityHash = pathIdentityHash(untrustedSession);
  escapedPath.evidence.artifactLocatorSetHash = canonicalHash(locatorProjection(escapedPath.outputs));
  refreshEvidenceHash(escapedPath);
  await requireRefusal(escapedPath, fixture.trustedRoot, /artifact_path_untrusted/);

  console.log(JSON.stringify({
    ok: true,
    proofMode: valid.proofMode,
    acceptedAsSupportEvidence: valid.acceptedAsSupportEvidence,
    acceptedForGpuHmr: valid.acceptedForGpuHmr,
    hostileChecks: [
      'forged_authority',
      'stale_evidence_hash',
      'input_set_mismatch',
      'output_hash_mismatch',
      'output_byte_length_mismatch',
      'untrusted_cas_path',
    ],
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
