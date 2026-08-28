import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  COLD_COMPILE_LOAD_RECEIPT_AUTHORITY,
  COLD_COMPILE_LOAD_RECEIPT_SCHEMA,
  verifyColdCompileLoadReceipt,
} from '../lib/gpu-hmr-cold-compile-load-receipt.mjs';

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function contentHash(value) {
  return sha256(Buffer.from(stableJson(value), 'utf8'));
}

function coldCompilerInput(sourceFilename, transformedSource) {
  const normalized = sourceFilename.replaceAll('\\', '/');
  const escaped = normalized.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return Buffer.concat([
    Buffer.from(`#line 1 "${escaped}"\n`, 'utf8'),
    transformedSource,
  ]);
}

function proofMaterial(proof) {
  return {
    schemaVersion: proof.schemaVersion,
    workspaceSlug: proof.workspaceSlug,
    runtimeSessionId: proof.runtimeSessionId,
    sourceEditId: proof.sourceEditId,
    selectedArtifactId: proof.selectedArtifactId,
    resultState: proof.resultState,
    degradedState: proof.degradedState,
    degradedReason: proof.degradedReason,
    stageResults: proof.stageResults,
    evidenceRefs: proof.evidenceRefs,
    visualEvidenceRefs: proof.visualEvidenceRefs,
    createdAt: proof.createdAt,
  };
}

function refreshProofId(proof) {
  proof.proofId = `gpu-proof:${contentHash(proofMaterial(proof)).slice(7)}`;
  return proof;
}

function mutateProof(proof, mutate) {
  const value = structuredClone(proof);
  mutate(value);
  return refreshProofId(value);
}

function refreshTransportAddress(proof) {
  const evidence = proof.evidenceRefs.find(
    (candidate) => candidate.kind === 'device-artifact-transport',
  );
  const hash = contentHash(evidence.metadata);
  evidence.contentHash = hash;
  evidence.evidenceId = `evidence:device-artifact-transport:${hash.slice(7)}`;
  const stage = proof.stageResults.find((candidate) => candidate.stageId === 'artifact-transport');
  stage.evidenceRefs = [evidence.evidenceId];
  return refreshProofId(proof);
}

function expectedContextFor(proof, requestId) {
  const compilerEvidence = proof.evidenceRefs.find(
    (candidate) => candidate.kind === 'device-compiler-output',
  );
  return {
    workspaceSlug: proof.workspaceSlug,
    runtimeSessionId: proof.runtimeSessionId,
    sourceEditId: proof.sourceEditId,
    proofId: proof.proofId,
    sourceFilename: compilerEvidence.metadata.compileProvenance.sourceFilename,
    artifactContentHash: proof.evidenceRefs.find(
      (candidate) => candidate.kind === 'device-artifact',
    ).contentHash,
    requestId,
  };
}

function otherHash(value) {
  const marker = value.endsWith('0') ? '1' : '0';
  return `${value.slice(0, -1)}${marker}`;
}

function mutateBytes(bytes) {
  const mutated = Buffer.from(bytes);
  mutated[0] ^= 0xff;
  return mutated;
}

function fixtureProof({
  requestSource,
  transforms,
  preprocessorInput,
  compilerInput,
  compilerStderr,
  artifact,
  sourceFilename,
}) {
  const artifactHash = sha256(artifact);
  const artifactId = `artifact:${artifactHash}`;
  const sourceEditId = `source-edit:sha256:${randomBytes(32).toString('hex')}`;
  const artifactEvidenceId = `evidence:device-artifact:${artifactHash.slice(7)}`;
  const compilerStderrHash = sha256(compilerStderr);
  const compilerEvidenceId = `evidence:device-compiler:${compilerStderrHash.slice(7)}`;
  let previous = requestSource;
  const sourceTransforms = transforms.map((output, index) => {
    const transform = {
      transform: `typed-transform-${index}`,
      attempt: index,
      inputSha256: sha256(previous),
      inputBytes: previous.byteLength,
      outputSha256: sha256(output),
      outputBytes: output.byteLength,
    };
    previous = output;
    return transform;
  });
  const compileProvenance = {
    compilerExecutable: '/opaque/toolchain/driver',
    compilerIdentity: randomBytes(32).toString('hex'),
    compilerResolvedPath: '/opaque/toolchain/driver',
    compilerExecutableHash: sha256(randomBytes(113)),
    compilerIdentityMethod: 'held_compiler_driver_entry_file_sha256+version_output',
    compilerDriverEntryFileAttested: true,
    compilerProcessImageAttested: false,
    compilerExecutionTransport: 'linux_parent_procfd_held_compiler_driver_entry_file',
    deviceCompiler: 'opaque-driver-label',
    gpuVendor: 'opaque-vendor-label',
    gpuArch: ['opaque-architecture-label'],
    targetTriple: 'opaque-target-label',
    sdkVersion: 'opaque-sdk-label',
    sourceFilename,
    effectiveDeviceFlags: [],
    compileCommandHash: randomBytes(32).toString('hex'),
    dependencyHash: sha256(compilerInput),
    dependencyMethod: 'compiler_preprocessed_translation_unit_sha256',
    artifactCacheKey: null,
    cacheHit: false,
    artifactCacheBypassed: true,
    compilerProcessExecuted: true,
    preprocessorProcessExecuted: true,
    preprocessorIdentityVerifiedAfterExecution: true,
    preprocessorCommandHash: randomBytes(32).toString('hex'),
    preprocessorElapsedMs: 7,
    compilerOutputFreshlyCreated: true,
    compilerPathIdentityVerifiedAfterExecution: true,
    compilerCachePolicy: 'empty_parent_environment_external_cache_state_unobserved',
    compilerCacheControls: {},
    compilerCacheEvidenceScope: 'no_declared_cache_controls_not_cache_miss_attestation',
    compilerEnvironmentScope:
      'empty_parent_environment_with_explicit_content_bound_control_contract',
    compilerIdentityScope:
      'held_compiler_driver_entry_file_bytes_bound_to_linux_parent_procfd_execution_child_toolchain_not_attested',
    compileCommandHashScope:
      'explicit_preprocess_and_compile_program_args_cwd_environment_overrides_piped_input_hashes_and_stdout_artifact_transport',
    compilerInputMode: 'compiler_preprocessed_translation_unit_piped_stdin',
    compilerOutputTransport: 'compiler_stdout_parent_materialized_held_reservation',
    compilerSourceEvidenceScope:
      'generated_device_stage_transform_chain_preprocessor_input_and_preprocessed_translation_unit_bound_to_compiler_input_not_original_request_provenance',
    requestSourceSha256: sha256(requestSource),
    requestSourceBytes: requestSource.byteLength,
    transformedSourceSha256: sha256(previous),
    transformedSourceBytes: previous.byteLength,
    preprocessorInputSha256: sha256(preprocessorInput),
    preprocessorInputBytes: preprocessorInput.byteLength,
    sourceTransforms,
    compiledSourceSha256: sha256(compilerInput),
    compiledSourceBytes: compilerInput.byteLength,
    sourceBytesVerifiedAfterExecution: true,
    artifactSha256: artifactHash,
    artifactBytes: artifact.byteLength,
  };
  const transportMetadata = {
    schemaVersion: 'synthi.gpu.hmr.artifact_transport.v1',
    selectedArtifactId: artifactId,
    artifactContentHash: artifactHash,
    artifactBytes: artifact.byteLength,
    compileOutputTransport: 'filesystem_path+ram_blob',
    compileOutputTransports: ['filesystem_path', 'ram_blob'],
    reloadRequestTransports: ['filesystem_path', 'ram_blob'],
    selectedLoaderTransport: null,
    ramArtifactReferenceProvided: true,
    ramBlobId: artifactId,
    ramBytesHash: artifactHash,
    fallbackRecorded: false,
    degradedState: 'gpu-hmr-ram-io-unavailable',
    degradedReason: 'selected_loader_transport_not_observed',
    partialModule: true,
    selectedArtifactKind: 'opaque-artifact-kind-label',
    requestedArtifactKind: 'opaque-requested-artifact-kind-label',
  };
  const transportHash = contentHash(transportMetadata);
  const transportEvidenceId =
    `evidence:device-artifact-transport:${transportHash.slice(7)}`;
  const proof = {
    schemaVersion: 'synthi.gpu.hmr.proof.v1',
    proofId: '',
    workspaceSlug: 'opaque-workspace-label',
    runtimeSessionId: `runtime-session:${randomBytes(16).toString('hex')}`,
    sourceEditId,
    selectedArtifactId: artifactId,
    resultState: 'gpu-hmr-compile-proven',
    degradedState: 'gpu-hmr-dispatch-unobserved',
    degradedReason: 'runtime dispatch has not been observed',
    stageResults: [
      {
        stageId: 'device-compile',
        stageName: 'renameable compile display label',
        status: 'passed',
        startedAt: '2026-07-16T00:00:00.000Z',
        completedAt: '2026-07-16T00:00:00.001Z',
        inputArtifactIds: [sourceEditId],
        outputArtifactIds: [artifactId],
        evidenceRefs: [artifactEvidenceId, compilerEvidenceId],
      },
      {
        stageId: 'artifact-transport',
        stageName: 'renameable transport display label',
        status: 'blocked',
        startedAt: '2026-07-16T00:00:00.001Z',
        completedAt: '2026-07-16T00:00:00.002Z',
        inputArtifactIds: [artifactId],
        outputArtifactIds: [artifactId],
        evidenceRefs: [transportEvidenceId],
        degradedState: 'gpu-hmr-ram-io-unavailable',
        degradedReason: 'selected loader transport not observed in immutable compile proof',
      },
      {
        stageId: 'runtime-dispatch-observation',
        stageName: 'renameable dispatch display label',
        status: 'blocked',
        startedAt: '2026-07-16T00:00:00.002Z',
        completedAt: '2026-07-16T00:00:00.003Z',
        inputArtifactIds: [artifactId],
        outputArtifactIds: [],
        evidenceRefs: [],
        degradedState: 'gpu-hmr-dispatch-unobserved',
        degradedReason: 'runtime dispatch has not been observed',
      },
    ],
    evidenceRefs: [
      {
        evidenceId: artifactEvidenceId,
        kind: 'device-artifact',
        contentHash: artifactHash,
        producerSubsystem: 'renameable-producer-label',
        timestamp: '2026-07-16T00:00:00.000Z',
        filePath: 'renameable/output.file',
        artifactUri: artifactId,
        summary: 'renameable artifact summary',
        metadata: {
          artifactBytes: artifact.byteLength,
          selectedArtifactKind: 'renameable-artifact-kind-label',
        },
      },
      {
        evidenceId: compilerEvidenceId,
        kind: 'device-compiler-output',
        contentHash: compilerStderrHash,
        producerSubsystem: 'renameable-producer-label',
        timestamp: '2026-07-16T00:00:00.000Z',
        summary: 'renameable compiler summary',
        metadata: {
          compilerElapsedMs: 11,
          stderrBytes: compilerStderr.byteLength,
          diagnostics: [],
          compileProvenance,
        },
      },
      {
        evidenceId: transportEvidenceId,
        kind: 'device-artifact-transport',
        contentHash: transportHash,
        producerSubsystem: 'renameable-producer-label',
        timestamp: '2026-07-16T00:00:00.000Z',
        artifactUri: artifactId,
        summary: 'renameable transport summary',
        metadata: transportMetadata,
      },
    ],
    visualEvidenceRefs: [],
    createdAt: '2026-07-16T00:00:00.000Z',
  };
  return refreshProofId(proof);
}

async function expectInvalid(proof, supplied, label) {
  await assert.rejects(
    verifyColdCompileLoadReceipt(proof, supplied),
    /cold_compile_load_receipt_invalid:/,
    label,
  );
}

const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-cold-compile-load-'));
try {
  const sourceFilename = 'arbitrary\\source tree\\device-with-quotes-"sample".opaque';
  const sourceTransformOutputBytes = [
    Buffer.from('extern "C" __global__ void arbitrary_stage_one() {}\n', 'utf8'),
    Buffer.from('extern "C" __global__ void arbitrary_stage_two() {}\n', 'utf8'),
  ];
  const generated = {
    requestSourceBytes: Buffer.from(
      'extern "C" __global__ void arbitrary_initial_source() {}\n',
      'utf8',
    ),
    sourceTransformOutputBytes,
    preprocessorInputBytes: coldCompilerInput(
      sourceFilename,
      sourceTransformOutputBytes.at(-1),
    ),
    compilerInputBytes: Buffer.from(
      '# 1 "arbitrary-preprocessed-input"\nvoid arbitrary_stage_two() {}\n',
      'utf8',
    ),
    compilerStderrBytes: Buffer.from('compiler diagnostic bytes\n', 'utf8'),
    artifactBytes: randomBytes(127),
  };
  const paths = {
    requestSourceBytes: path.join(root, 'request-source.blob'),
    preprocessorInputBytes: path.join(root, 'preprocessor-input.blob'),
    compilerInputBytes: path.join(root, 'compiler-input.blob'),
    compilerStderrBytes: path.join(root, 'compiler-stderr.blob'),
    artifactBytes: path.join(root, 'artifact.blob'),
    transforms: generated.sourceTransformOutputBytes.map((_, index) => (
      path.join(root, `transform-${index}.blob`)
    )),
  };
  await Promise.all([
    writeFile(paths.requestSourceBytes, generated.requestSourceBytes),
    writeFile(paths.preprocessorInputBytes, generated.preprocessorInputBytes),
    writeFile(paths.compilerInputBytes, generated.compilerInputBytes),
    writeFile(paths.compilerStderrBytes, generated.compilerStderrBytes),
    writeFile(paths.artifactBytes, generated.artifactBytes),
    ...paths.transforms.map((file, index) => (
      writeFile(file, generated.sourceTransformOutputBytes[index])
    )),
  ]);
  const bytes = {
    requestSourceBytes: await readFile(paths.requestSourceBytes),
    sourceTransformOutputBytes: await Promise.all(
      paths.transforms.map((file) => readFile(file)),
    ),
    preprocessorInputBytes: await readFile(paths.preprocessorInputBytes),
    compilerInputBytes: await readFile(paths.compilerInputBytes),
    compilerStderrBytes: await readFile(paths.compilerStderrBytes),
    artifactBytes: await readFile(paths.artifactBytes),
  };
  const proof = fixtureProof({
    requestSource: bytes.requestSourceBytes,
    transforms: bytes.sourceTransformOutputBytes,
    preprocessorInput: bytes.preprocessorInputBytes,
    compilerInput: bytes.compilerInputBytes,
    compilerStderr: bytes.compilerStderrBytes,
    artifact: bytes.artifactBytes,
    sourceFilename,
  });
  const requestId = `gpu-reload:request:${randomBytes(16).toString('hex')}`;
  const runnerTerminal = {
    schemaVersion: 'synthi.runner.gpu_artifact_load_result.v1',
    status: 'loaded',
    module: 'device',
    requestId,
    sourceEditId: proof.sourceEditId,
    artifactContentHash: sha256(bytes.artifactBytes),
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
  };
  const supplied = {
    requestId,
    ...bytes,
    runnerTerminal,
    expectedContext: expectedContextFor(proof, requestId),
  };

  const receipt = await verifyColdCompileLoadReceipt(proof, supplied);
  assert.equal(receipt.schemaVersion, COLD_COMPILE_LOAD_RECEIPT_SCHEMA);
  assert.equal(receipt.proofAuthority, COLD_COMPILE_LOAD_RECEIPT_AUTHORITY);
  assert.equal(receipt.requestSourceHash, sha256(bytes.requestSourceBytes));
  assert.equal(receipt.preprocessorInputHash, sha256(bytes.preprocessorInputBytes));
  assert.equal(receipt.compilerInputHash, sha256(bytes.compilerInputBytes));
  assert.equal(receipt.compilerStderrHash, sha256(bytes.compilerStderrBytes));
  assert.equal(receipt.artifactContentHash, sha256(bytes.artifactBytes));
  assert.equal(receipt.sourceTransformBindings.length, 2);
  assert.equal(receipt.callerSuppliedBytesInternallyConsistent, true);
  assert.equal(receipt.preprocessorInputInternallyRecomputed, true);
  assert.equal(receipt.compilerEvidenceBytesInternallyConsistent, true);
  assert.equal(receipt.recomputedProofIdMatches, true);
  assert.equal(receipt.transportMetadataHashInternallyConsistent, true);
  assert.equal(receipt.runnerTerminalInternallyCorrelated, true);
  assert.equal(receipt.expectedCurrentContextMatched, true);
  assert.equal(receipt.proofArtifactTrust, 'caller_supplied_untrusted');
  assert.equal(receipt.expectedContextTrust, 'caller_supplied_untrusted');
  assert.equal(receipt.runnerTerminalTrust, 'caller_supplied_untrusted');
  assert.equal(receipt.trustedProducerObserved, false);
  assert.equal(receipt.diagnosticOnly, true);
  assert.equal(receipt.acceptedAsSupportEvidence, false);
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.acceptedForGpuHmr, false);
  assert.equal(receipt.gpuHmrSuccess, false);
  assert.equal(receipt.canSatisfyRuntimeProof, false);
  assert.equal(receipt.canSatisfyDispatchProof, false);

  const emptyCompilerStderr = Buffer.alloc(0);
  const emptyStderrProof = fixtureProof({
    requestSource: bytes.requestSourceBytes,
    transforms: bytes.sourceTransformOutputBytes,
    preprocessorInput: bytes.preprocessorInputBytes,
    compilerInput: bytes.compilerInputBytes,
    compilerStderr: emptyCompilerStderr,
    artifact: bytes.artifactBytes,
    sourceFilename,
  });
  const emptyStderrRequestId =
    `gpu-reload:request:${randomBytes(16).toString('hex')}`;
  const emptyStderrReceipt = await verifyColdCompileLoadReceipt(emptyStderrProof, {
    ...bytes,
    compilerStderrBytes: emptyCompilerStderr,
    requestId: emptyStderrRequestId,
    runnerTerminal: {
      ...runnerTerminal,
      requestId: emptyStderrRequestId,
      sourceEditId: emptyStderrProof.sourceEditId,
    },
    expectedContext: expectedContextFor(emptyStderrProof, emptyStderrRequestId),
  });
  assert.equal(emptyStderrReceipt.compilerStderrBytes, 0);
  assert.equal(emptyStderrReceipt.compilerEvidenceBytesInternallyConsistent, true);

  const noTransformPreprocessorInput = coldCompilerInput(
    sourceFilename,
    bytes.requestSourceBytes,
  );
  const noTransformProof = fixtureProof({
    requestSource: bytes.requestSourceBytes,
    transforms: [],
    preprocessorInput: noTransformPreprocessorInput,
    compilerInput: bytes.compilerInputBytes,
    compilerStderr: bytes.compilerStderrBytes,
    artifact: bytes.artifactBytes,
    sourceFilename,
  });
  const noTransformRequestId =
    `gpu-reload:request:${randomBytes(16).toString('hex')}`;
  const noTransformReceipt = await verifyColdCompileLoadReceipt(noTransformProof, {
    ...bytes,
    sourceTransformOutputBytes: [],
    preprocessorInputBytes: noTransformPreprocessorInput,
    requestId: noTransformRequestId,
    runnerTerminal: {
      ...runnerTerminal,
      requestId: noTransformRequestId,
      sourceEditId: noTransformProof.sourceEditId,
    },
    expectedContext: expectedContextFor(noTransformProof, noTransformRequestId),
  });
  assert.equal(noTransformReceipt.sourceTransformBindings.length, 0);
  assert.equal(noTransformReceipt.preprocessorInputInternallyRecomputed, true);

  const renamed = structuredClone(proof);
  renamed.workspaceSlug = 'entirely-different-workspace-label';
  renamed.stageResults[0].stageName = 'entirely-different-compile-display-label';
  renamed.evidenceRefs[0].summary = 'entirely different artifact summary';
  renamed.evidenceRefs[0].filePath = 'renamed/artifact.with-another-extension';
  renamed.evidenceRefs[0].producerSubsystem = 'renamed-producer-label';
  const renamedMetadata = renamed.evidenceRefs[1].metadata.compileProvenance;
  renamedMetadata.compilerExecutable = '/renamed/toolchain/entry';
  renamedMetadata.deviceCompiler = 'renamed-compiler-label';
  renamedMetadata.gpuVendor = 'renamed-vendor-label';
  renamedMetadata.gpuArch = ['renamed-architecture-label'];
  renamedMetadata.targetTriple = 'renamed-target-triple-label';
  renamedMetadata.sdkVersion = 'renamed-sdk-label';
  refreshProofId(renamed);
  const renamedReceipt = await verifyColdCompileLoadReceipt(renamed, {
    ...supplied,
    expectedContext: expectedContextFor(renamed, requestId),
  });
  assert.equal(renamedReceipt.callerSuppliedBytesInternallyConsistent, true);
  assert.equal(renamedReceipt.runnerTerminalInternallyCorrelated, true);
  assert.equal(renamedReceipt.acceptedAsSupportEvidence, false);
  assert.notEqual(renamedReceipt.proofArtifactHash, receipt.proofArtifactHash);

  await expectInvalid(proof, {
    ...supplied,
    requestSourceBytes: mutateBytes(bytes.requestSourceBytes),
  }, 'mutated request source bytes');
  for (let index = 0; index < bytes.sourceTransformOutputBytes.length; index += 1) {
    const outputs = bytes.sourceTransformOutputBytes.map(Buffer.from);
    outputs[index] = mutateBytes(outputs[index]);
    await expectInvalid(proof, {
      ...supplied,
      sourceTransformOutputBytes: outputs,
    }, `mutated transform ${index} bytes`);
  }
  await expectInvalid(proof, {
    ...supplied,
    preprocessorInputBytes: mutateBytes(bytes.preprocessorInputBytes),
  }, 'mutated semantic preprocessor input bytes');
  await expectInvalid(proof, {
    ...supplied,
    compilerInputBytes: mutateBytes(bytes.compilerInputBytes),
  }, 'mutated compiler input bytes');
  await expectInvalid(proof, {
    ...supplied,
    compilerStderrBytes: mutateBytes(bytes.compilerStderrBytes),
  }, 'mutated compiler stderr bytes');
  await expectInvalid(proof, {
    ...supplied,
    artifactBytes: mutateBytes(bytes.artifactBytes),
  }, 'mutated artifact bytes');

  const hashMutations = [
    ['request source hash', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.requestSourceSha256 =
        otherHash(value.evidenceRefs[1].metadata.compileProvenance.requestSourceSha256);
    }],
    ['transform input hash', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.sourceTransforms[0].inputSha256 =
        otherHash(value.evidenceRefs[1].metadata.compileProvenance.sourceTransforms[0].inputSha256);
    }],
    ['transform output hash', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.sourceTransforms[1].outputSha256 =
        otherHash(value.evidenceRefs[1].metadata.compileProvenance.sourceTransforms[1].outputSha256);
    }],
    ['transformed source hash', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.transformedSourceSha256 =
        otherHash(value.evidenceRefs[1].metadata.compileProvenance.transformedSourceSha256);
    }],
    ['preprocessor input hash', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.preprocessorInputSha256 =
        otherHash(value.evidenceRefs[1].metadata.compileProvenance.preprocessorInputSha256);
    }],
    ['compiler input hash', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.compiledSourceSha256 =
        otherHash(value.evidenceRefs[1].metadata.compileProvenance.compiledSourceSha256);
    }],
    ['dependency hash', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.dependencyHash =
        otherHash(value.evidenceRefs[1].metadata.compileProvenance.dependencyHash);
    }],
    ['artifact metadata hash', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.artifactSha256 =
        otherHash(value.evidenceRefs[1].metadata.compileProvenance.artifactSha256);
    }],
    ['artifact evidence hash', (value) => {
      value.evidenceRefs[0].contentHash = otherHash(value.evidenceRefs[0].contentHash);
    }],
    ['artifact evidence id', (value) => {
      value.evidenceRefs[0].evidenceId =
        `evidence:device-artifact:${randomBytes(32).toString('hex')}`;
      value.stageResults[0].evidenceRefs[0] = value.evidenceRefs[0].evidenceId;
    }],
    ['compiler evidence hash', (value) => {
      value.evidenceRefs[1].contentHash = otherHash(value.evidenceRefs[1].contentHash);
    }],
    ['compiler evidence id', (value) => {
      value.evidenceRefs[1].evidenceId =
        `evidence:device-compiler:${randomBytes(32).toString('hex')}`;
      value.stageResults[0].evidenceRefs[1] = value.evidenceRefs[1].evidenceId;
    }],
    ['transport evidence hash', (value) => {
      value.evidenceRefs[2].contentHash = otherHash(value.evidenceRefs[2].contentHash);
    }],
    ['transport evidence id', (value) => {
      value.evidenceRefs[2].evidenceId =
        `evidence:device-artifact-transport:${randomBytes(32).toString('hex')}`;
      value.stageResults[1].evidenceRefs[0] = value.evidenceRefs[2].evidenceId;
    }],
    ['transport artifact hash', (value) => {
      value.evidenceRefs[2].metadata.artifactContentHash =
        otherHash(value.evidenceRefs[2].metadata.artifactContentHash);
    }],
  ];
  for (const [label, mutate] of hashMutations) {
    const mutated = mutateProof(proof, mutate);
    await expectInvalid(mutated, supplied, label);
  }

  const lengthMutations = [
    ['request source length', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.requestSourceBytes += 1;
    }],
    ['transformed source length', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.transformedSourceBytes += 1;
    }],
    ['preprocessor input length', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.preprocessorInputBytes += 1;
    }],
    ['compiler input length', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.compiledSourceBytes += 1;
    }],
    ['artifact metadata length', (value) => {
      value.evidenceRefs[1].metadata.compileProvenance.artifactBytes += 1;
    }],
    ['artifact evidence length', (value) => {
      value.evidenceRefs[0].metadata.artifactBytes += 1;
    }],
    ['compiler stderr length', (value) => {
      value.evidenceRefs[1].metadata.stderrBytes += 1;
    }],
    ['transport artifact length', (value) => {
      value.evidenceRefs[2].metadata.artifactBytes += 1;
    }],
  ];
  for (let index = 0; index < bytes.sourceTransformOutputBytes.length; index += 1) {
    lengthMutations.push(
      [`transform ${index} input length`, (value) => {
        value.evidenceRefs[1].metadata.compileProvenance
          .sourceTransforms[index].inputBytes += 1;
      }],
      [`transform ${index} output length`, (value) => {
        value.evidenceRefs[1].metadata.compileProvenance
          .sourceTransforms[index].outputBytes += 1;
      }],
    );
  }
  for (const [label, mutate] of lengthMutations) {
    const mutated = mutateProof(proof, mutate);
    await expectInvalid(mutated, supplied, label);
  }

  const stageMutation = mutateProof(proof, (value) => {
    value.stageResults[0].outputArtifactIds = [
      `artifact:sha256:${randomBytes(32).toString('hex')}`,
    ];
  });
  await expectInvalid(stageMutation, supplied, 'mutated artifact stage link');

  const filenameMutation = mutateProof(proof, (value) => {
    value.evidenceRefs[1].metadata.compileProvenance.sourceFilename =
      'different/semantic-input-name.hip';
  });
  await expectInvalid(filenameMutation, supplied, 'mutated semantic source filename');

  const transportMetadataMutation = mutateProof(proof, (value) => {
    value.evidenceRefs[2].metadata.compileOutputTransport = 'mutated-transport-label';
  });
  await expectInvalid(
    transportMetadataMutation,
    supplied,
    'mutated transport metadata without content address update',
  );

  const selectedLoaderMutation = structuredClone(proof);
  selectedLoaderMutation.evidenceRefs[2].metadata.selectedLoaderTransport = 'ram_blob';
  refreshTransportAddress(selectedLoaderMutation);
  await expectInvalid(
    selectedLoaderMutation,
    supplied,
    'compile proof cannot retroactively claim selected loader transport',
  );

  const proofIdMutation = structuredClone(proof);
  proofIdMutation.proofId = `gpu-proof:${randomBytes(32).toString('hex')}`;
  await expectInvalid(proofIdMutation, supplied, 'mutated proof id');

  const unexpectedVisualEvidence = mutateProof(proof, (value) => {
    value.visualEvidenceRefs.push({
      evidenceId: `evidence:visual:${randomBytes(32).toString('hex')}`,
      kind: 'visual-output',
      contentHash: sha256(randomBytes(11)),
      producerSubsystem: 'untrusted-visual-label',
      timestamp: '2026-07-16T00:00:00.000Z',
      summary: 'visual evidence must be verified by the visual proof path',
    });
  });
  await expectInvalid(
    unexpectedVisualEvidence,
    supplied,
    'cold compile receipt cannot absorb visual proof',
  );

  const authorityClaim = structuredClone(proof);
  authorityClaim.gpuHmrSuccess = true;
  await expectInvalid(authorityClaim, supplied, 'proof artifact authority claim');

  for (const [label, key, claimed] of [
    ['nested string GPU HMR claim', 'gpu_hmr_success', 'true'],
    ['nested numeric runtime claim', 'canSatisfyRuntimeProof', 1],
    ['nested proof authority claim', 'proofAuthority', 'gpu_hmr_success_authority'],
  ]) {
    const nestedClaim = mutateProof(proof, (value) => {
      value.evidenceRefs[0].metadata[key] = claimed;
    });
    await expectInvalid(nestedClaim, supplied, label);
  }

  const nonAuthoritativeMetadata = mutateProof(proof, (value) => {
    value.evidenceRefs[0].metadata.proofAuthority =
      'artifact_bytes_support_only_not_gpu_hmr_success_or_runtime_authority';
  });
  const nonAuthoritativeReceipt = await verifyColdCompileLoadReceipt(
    nonAuthoritativeMetadata,
    {
      ...supplied,
      expectedContext: expectedContextFor(nonAuthoritativeMetadata, requestId),
    },
  );
  assert.equal(nonAuthoritativeReceipt.diagnosticOnly, true);
  assert.equal(nonAuthoritativeReceipt.acceptedAsSupportEvidence, false);

  const expectedContextMutations = [
    ['workspace', 'workspaceSlug', 'different-current-workspace'],
    ['runtime session', 'runtimeSessionId', 'different-current-runtime-session'],
    [
      'source edit',
      'sourceEditId',
      `source-edit:sha256:${randomBytes(32).toString('hex')}`,
    ],
    ['proof id', 'proofId', `gpu-proof:${randomBytes(32).toString('hex')}`],
    ['semantic source filename', 'sourceFilename', 'different/current-source.opaque'],
    ['artifact hash', 'artifactContentHash', sha256(randomBytes(127))],
    ['request id', 'requestId', `gpu-reload:request:${randomBytes(16).toString('hex')}`],
  ];
  for (const [label, key, replacement] of expectedContextMutations) {
    await expectInvalid(proof, {
      ...supplied,
      expectedContext: {
        ...supplied.expectedContext,
        [key]: replacement,
      },
    }, `mismatched expected current ${label}`);
  }

  await expectInvalid(proof, {
    ...supplied,
    requestId: `gpu-reload:request:${randomBytes(16).toString('hex')}`,
  }, 'mutated expected request correlation');
  await expectInvalid(proof, {
    ...supplied,
    runnerTerminal: {
      ...runnerTerminal,
      requestId: `gpu-reload:request:${randomBytes(16).toString('hex')}`,
    },
  }, 'mutated terminal request correlation');
  await expectInvalid(proof, {
    ...supplied,
    runnerTerminal: {
      ...runnerTerminal,
      sourceEditId: `source-edit:sha256:${randomBytes(32).toString('hex')}`,
    },
  }, 'mutated terminal source edit correlation');
  await expectInvalid(proof, {
    ...supplied,
    runnerTerminal: {
      ...runnerTerminal,
      artifactContentHash: sha256(randomBytes(127)),
    },
  }, 'mutated terminal artifact correlation');
  await expectInvalid(proof, {
    ...supplied,
    runnerTerminal: {
      ...runnerTerminal,
      gpuHmrSuccess: true,
    },
  }, 'runner terminal authority claim');

  for (const missing of [
    'requestId',
    'requestSourceBytes',
    'sourceTransformOutputBytes',
    'preprocessorInputBytes',
    'compilerInputBytes',
    'compilerStderrBytes',
    'artifactBytes',
    'runnerTerminal',
    'expectedContext',
  ]) {
    const incomplete = { ...supplied };
    delete incomplete[missing];
    await expectInvalid(proof, incomplete, `missing ${missing}`);
  }
  await expectInvalid(proof, {
    ...supplied,
    sourceTransformOutputBytes: supplied.sourceTransformOutputBytes.slice(0, -1),
  }, 'missing one ordered transform output');

  process.stdout.write(JSON.stringify({
    status: 'gpu_hmr_cold_compile_load_receipt_self_check_passed',
    schemaVersion: receipt.schemaVersion,
    receiptHash: receipt.receiptHash,
    transformCount: receipt.sourceTransformBindings.length,
    labelRenamingInvariant: true,
    authority: {
      diagnosticOnly: receipt.diagnosticOnly,
      trustedProducerObserved: receipt.trustedProducerObserved,
      acceptedAsSupportEvidence: receipt.acceptedAsSupportEvidence,
      acceptedForGpuHmr: receipt.acceptedForGpuHmr,
      gpuHmrSuccess: receipt.gpuHmrSuccess,
      canSatisfyRuntimeProof: receipt.canSatisfyRuntimeProof,
    },
  }, null, 2));
  process.stdout.write('\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
