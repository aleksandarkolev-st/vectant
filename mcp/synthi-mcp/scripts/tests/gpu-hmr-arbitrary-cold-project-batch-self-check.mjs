import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createArbitraryColdProjectRunFailure,
  verifyArbitraryColdProjectRunFailure,
} from '../gpu-hmr-arbitrary-cold-project-runner.mjs';
import {
  ARBITRARY_COLD_BATCH_REPORT_AUTHORITY,
  ARBITRARY_COLD_BATCH_REPORT_SCHEMA,
  runArbitraryColdProjectBatch,
  verifyArbitraryColdProjectBatchReport,
} from '../gpu-hmr-arbitrary-cold-project-batch.mjs';
import {
  ARBITRARY_COLD_BATCH_SELECTION_AUTHORITY,
  ARBITRARY_COLD_BATCH_SELECTION_SCHEMA,
  ARBITRARY_COLD_BATCH_SUMMARY_AUTHORITY,
  ARBITRARY_COLD_BATCH_SUMMARY_SCHEMA,
  createArbitraryColdBatchSummary,
  createRefusedArbitraryColdBatchAttempt,
  discoverArbitraryColdProjectDescriptors,
  selectArbitraryColdProjectDescriptors,
  verifyArbitraryColdBatchSelection,
} from '../lib/gpu-hmr-arbitrary-cold-project-batch.mjs';
import {
  ARBITRARY_COLD_RETAINED_EVIDENCE_AUTHORITY,
  ARBITRARY_COLD_RETAINED_EVIDENCE_SCHEMA,
  recomputeArbitraryColdRetainedEvidence,
  verifyArbitraryColdRetainedEvidence,
} from '../lib/gpu-hmr-arbitrary-cold-retained-evidence.mjs';
import {
  verifyArbitraryColdRetainedExecutionChain,
} from '../lib/gpu-hmr-arbitrary-cold-retained-chain.mjs';
import {
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-arbitrary-cold-batch-'));

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rehashEvidence(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  return `sha256:${createHash('sha256').update(stableJson(projection)).digest('hex')}`;
}

function descriptor(sourceRoot, variant) {
  const outputPath = `result-${variant}.bin`;
  return {
    schemaVersion: 'synthi.gpu_hmr.arbitrary_cold_project_descriptor.v1',
    sourceRoot,
    readOnlyInputs: [],
    workerImage: COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
    containerRuntime: 'runc',
    command: '/bin/sh',
    args: [
      '-lc',
      `printf 'arbitrary cold batch ${variant}\\n' > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/${outputPath}'`,
    ],
    environment: {
      HOME: '/tmp/cold-home',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      TMPDIR: '/tmp',
      VARIANT: String(variant),
    },
    workingDirectory: '.',
    outputs: [{
      path: outputPath,
      role: 'opaque_result',
      artifactKind: 'opaque_build_output',
      mediaType: 'application/octet-stream',
    }],
    sourceLimits: {
      maxEntryCount: 4096,
      maxByteLength: 64 * 1024 * 1024,
    },
    resources: {
      commandTimeoutMillis: 30_000,
      releaseTimeoutMillis: 30_000,
      workspaceByteLimit: 128 * 1024 * 1024,
      workspaceEntryLimit: 4096,
      collectedByteLimit: 16 * 1024 * 1024,
      collectedEntryLimit: 16,
      memoryBytes: 1024 * 1024 * 1024,
      memorySwapBytes: 1024 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 256,
      nofileLimit: 1024,
    },
  };
}

try {
  const descriptorRoot = path.join(root, 'descriptor inputs');
  const nestedRoot = path.join(descriptorRoot, 'nested');
  const sourceRoot = path.join(root, 'source input');
  const artifactRoot = path.join(root, 'artifact output');
  await Promise.all([
    mkdir(nestedRoot, { recursive: true }),
    mkdir(sourceRoot, { recursive: true }),
    mkdir(artifactRoot, { recursive: true }),
  ]);
  await writeFile(path.join(sourceRoot, 'input.txt'), 'bound source bytes\n');
  const descriptorPaths = [];
  for (let variant = 0; variant < 4; variant += 1) {
    const parent = variant % 2 === 0 ? descriptorRoot : nestedRoot;
    const descriptorPath = path.join(parent, `arbitrary-${variant}.json`);
    await writeFile(descriptorPath, JSON.stringify(descriptor(sourceRoot, variant)));
    descriptorPaths.push(descriptorPath);
  }
  await writeFile(path.join(descriptorRoot, 'README.txt'), 'ignored non-descriptor bytes\n');

  const recordsBeforeRename = await discoverArbitraryColdProjectDescriptors(descriptorRoot);
  assert.equal(recordsBeforeRename.length, 4);
  const selectionBeforeRename = selectArbitraryColdProjectDescriptors(recordsBeforeRename, {
    seed: 'reproducible-user-seed',
    sampleCount: 2,
  });
  assert.equal(selectionBeforeRename.schemaVersion, ARBITRARY_COLD_BATCH_SELECTION_SCHEMA);
  assert.equal(selectionBeforeRename.proofAuthority, ARBITRARY_COLD_BATCH_SELECTION_AUTHORITY);
  assert.equal(selectionBeforeRename.acceptedAsColdBuildEvidence, false);
  assert.equal(selectionBeforeRename.acceptedForGpuHmr, false);
  assert.equal(selectionBeforeRename.gpuHmrSuccess, false);
  assert.equal(selectionBeforeRename.canSatisfyRuntimeProof, false);
  assert.equal(selectionBeforeRename.canSatisfyDispatchProof, false);
  assert.equal(
    verifyArbitraryColdBatchSelection(selectionBeforeRename, recordsBeforeRename),
    selectionBeforeRename,
  );
  assert.throws(
    () => verifyArbitraryColdBatchSelection(
      structuredClone(selectionBeforeRename),
      recordsBeforeRename,
    ),
    /selection_invalid/,
  );

  await Promise.all(descriptorPaths.map((descriptorPath, index) => rename(
    descriptorPath,
    path.join(path.dirname(descriptorPath), `renamed-${3 - index}.json`),
  )));
  const recordsAfterRename = await discoverArbitraryColdProjectDescriptors(descriptorRoot);
  const selectionAfterRename = selectArbitraryColdProjectDescriptors(recordsAfterRename, {
    seed: 'reproducible-user-seed',
    sampleCount: 2,
  });
  assert.deepEqual(selectionAfterRename.selected, selectionBeforeRename.selected);
  assert.equal(selectionAfterRename.descriptorSetHash, selectionBeforeRename.descriptorSetHash);
  assert.equal(JSON.stringify(selectionAfterRename).includes('renamed-'), false);

  const forgedRecord = structuredClone(recordsAfterRename[0]);
  forgedRecord.descriptor.environment.VARIANT = 'forged';
  assert.throws(
    () => selectArbitraryColdProjectDescriptors([forgedRecord], {
      seed: 'forged-record-seed',
      sampleCount: 1,
    }),
    /descriptor_record_invalid/,
  );

  const duplicateRoot = path.join(root, 'duplicate descriptors');
  await mkdir(duplicateRoot);
  const duplicateBytes = JSON.stringify(descriptor(sourceRoot, 9));
  await Promise.all([
    writeFile(path.join(duplicateRoot, 'first.json'), duplicateBytes),
    writeFile(path.join(duplicateRoot, 'second.json'), duplicateBytes),
  ]);
  await assert.rejects(
    () => discoverArbitraryColdProjectDescriptors(duplicateRoot),
    /duplicate_descriptor_refused/,
  );

  const linkedRoot = path.join(root, 'linked descriptors');
  await mkdir(linkedRoot);
  let symlinkCreated = false;
  try {
    await symlink(
      nestedRoot,
      path.join(linkedRoot, 'linked-tree'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    symlinkCreated = true;
  } catch {
    symlinkCreated = false;
  }
  if (symlinkCreated) {
    await assert.rejects(
      () => discoverArbitraryColdProjectDescriptors(linkedRoot),
      /tree_symlink_refused/,
    );
  }

  const refusalSelection = selectArbitraryColdProjectDescriptors(recordsAfterRename, {
    seed: 'refusal-seed',
    sampleCount: 1,
  });
  const failure = createArbitraryColdProjectRunFailure(
    new Error('arbitrary_cold_batch_expected_refusal'),
  );
  verifyArbitraryColdProjectRunFailure(failure);
  const refusedAttempt = createRefusedArbitraryColdBatchAttempt({
    selection: refusalSelection,
    records: recordsAfterRename,
    descriptorHash: refusalSelection.selected[0].descriptorHash,
    failure,
  });
  assert.equal(refusedAttempt.retainedExecutionChainHash, null);
  const refusalSummary = createArbitraryColdBatchSummary(
    refusalSelection,
    recordsAfterRename,
    [refusedAttempt],
  );
  assert.equal(refusalSummary.schemaVersion, ARBITRARY_COLD_BATCH_SUMMARY_SCHEMA);
  assert.equal(refusalSummary.proofAuthority, ARBITRARY_COLD_BATCH_SUMMARY_AUTHORITY);
  assert.equal(refusalSummary.refusedColdRunCount, 1);
  assert.equal(refusalSummary.completedColdRunCount, 0);
  assert.equal(refusalSummary.acceptedAsColdBuildEvidence, false);
  assert.equal(refusalSummary.acceptedForGpuHmr, false);
  assert.equal(refusalSummary.gpuHmrSuccess, false);
  assert.throws(
    () => createArbitraryColdBatchSummary(
      refusalSelection,
      recordsAfterRename,
      [structuredClone(refusedAttempt)],
    ),
    /attempts_invalid/,
  );

  const batch = await runArbitraryColdProjectBatch({
    descriptorRoot,
    artifactRoot,
    sampleCount: 1,
    seed: 'live-batch-seed',
  });
  assert.equal(batch.schemaVersion, ARBITRARY_COLD_BATCH_REPORT_SCHEMA);
  assert.equal(batch.proofAuthority, ARBITRARY_COLD_BATCH_REPORT_AUTHORITY);
  assert.equal(batch.acceptedAsColdBuildEvidence, false);
  assert.equal(batch.acceptedForGpuHmr, false);
  assert.equal(batch.gpuHmrSuccess, false);
  assert.equal(batch.canSatisfyRuntimeProof, false);
  assert.equal(batch.canSatisfyDispatchProof, false);
  assert.equal(verifyArbitraryColdProjectBatchReport(batch), batch);
  const forgedBatch = structuredClone(batch);
  forgedBatch.acceptedForGpuHmr = true;
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedBatch),
    /batch_report_invalid/,
  );
  assert.equal(batch.summary.attemptedCount, 1);
  assert.equal(batch.summary.completedColdRunCount, 1);
  assert.equal(batch.summary.refusedColdRunCount, 0);
  assert.equal(batch.summary.acceptedAsColdBuildEvidence, false);
  assert.equal(batch.summary.acceptedForGpuHmr, false);
  assert.equal(batch.summary.gpuHmrSuccess, false);
  assert.equal(batch.reports[0].outcome, 'cold_run_completed');
  assert.equal(batch.reports[0].runEvidence.acceptedAsColdBuildEvidence, true);
  assert.equal(batch.reports[0].runEvidence.acceptedForGpuHmr, false);
  assert.equal(batch.reports[0].runEvidence.gpuHmrSuccess, false);
  assert.equal(
    verifyArbitraryColdRetainedExecutionChain(batch.reports[0].retainedExecutionChain),
    batch.reports[0].retainedExecutionChain,
  );
  assert.equal(
    batch.summary.attempts[0].retainedExecutionChainHash,
    batch.reports[0].retainedExecutionChain.evidenceHash,
  );
  assert.equal(batch.reports[0].outputs.length, 1);
  assert.equal(JSON.stringify(batch).includes('renamed-'), false);
  assert.equal(JSON.stringify(batch).includes('arbitrary cold batch'), false);

  const forgedRetainedChain = structuredClone(batch);
  forgedRetainedChain.reports[0].retainedExecutionChain
    .contractReceipt.commandInvocationHash = `sha256:${'0'.repeat(64)}`;
  forgedRetainedChain.reports[0].retainedExecutionChain
    .contractReceipt.evidenceHash = rehashEvidence(
      forgedRetainedChain.reports[0].retainedExecutionChain.contractReceipt,
    );
  forgedRetainedChain.reports[0].retainedExecutionChain.evidenceHash = rehashEvidence(
    forgedRetainedChain.reports[0].retainedExecutionChain,
  );
  forgedRetainedChain.summary.attempts[0].retainedExecutionChainHash =
    forgedRetainedChain.reports[0].retainedExecutionChain.evidenceHash;
  forgedRetainedChain.summary.attempts[0].evidenceHash = rehashEvidence(
    forgedRetainedChain.summary.attempts[0],
  );
  forgedRetainedChain.summary.evidenceHash = rehashEvidence(forgedRetainedChain.summary);
  forgedRetainedChain.evidenceHash = rehashEvidence(forgedRetainedChain);
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedRetainedChain),
    /batch_report_invalid/,
  );

  const retainedEvidence = await recomputeArbitraryColdRetainedEvidence(
    batch,
    recordsAfterRename,
    {
      allowedArtifactRoots: [artifactRoot],
      samplingSeed: 'live-batch-seed',
      expectedBatchReportEvidenceHash: batch.evidenceHash,
    },
  );
  assert.equal(retainedEvidence.schemaVersion, ARBITRARY_COLD_RETAINED_EVIDENCE_SCHEMA);
  assert.equal(retainedEvidence.proofAuthority, ARBITRARY_COLD_RETAINED_EVIDENCE_AUTHORITY);
  assert.equal(retainedEvidence.acceptedAsRetainedBatchEvidence, true);
  assert.equal(retainedEvidence.acceptedAsRetainedColdOutputEvidence, true);
  assert.equal(retainedEvidence.acceptedAsColdBuildEvidence, false);
  assert.equal(retainedEvidence.acceptedForGpuHmr, false);
  assert.equal(retainedEvidence.gpuHmrSuccess, false);
  assert.equal(retainedEvidence.canSatisfyRuntimeProof, false);
  assert.equal(retainedEvidence.canSatisfyDispatchProof, false);
  assert.equal(retainedEvidence.samplingSeedPreimageVerified, true);
  assert.equal(retainedEvidence.externalReportHashMatched, true);
  assert.equal(retainedEvidence.sourceBindingManifestsRetained, true);
  assert.equal(retainedEvidence.executionChainRecordsRetained, true);
  assert.equal(
    retainedEvidence.limitations.includes('source_binding_manifest_not_retained'),
    false,
  );
  assert.equal(
    retainedEvidence.limitations.includes('execution_chain_records_not_retained'),
    false,
  );
  assert.equal(retainedEvidence.verifiedArtifactCount, 1);
  assert.equal(verifyArbitraryColdRetainedEvidence(retainedEvidence), retainedEvidence);
  const unanchoredRetainedEvidence = await recomputeArbitraryColdRetainedEvidence(
    batch,
    recordsAfterRename,
    { allowedArtifactRoots: [artifactRoot] },
  );
  assert.equal(unanchoredRetainedEvidence.samplingSeedPreimageVerified, false);
  assert.equal(unanchoredRetainedEvidence.externalReportHashMatched, false);
  assert.ok(unanchoredRetainedEvidence.limitations.includes(
    'sampling_seed_preimage_not_supplied',
  ));
  assert.ok(unanchoredRetainedEvidence.limitations.includes(
    'external_authenticity_anchor_not_supplied',
  ));
  await assert.rejects(
    () => recomputeArbitraryColdRetainedEvidence(
      batch,
      recordsAfterRename,
      {
        allowedArtifactRoots: [artifactRoot],
        samplingSeed: 'wrong-seed',
        expectedBatchReportEvidenceHash: batch.evidenceHash,
      },
    ),
    /sampling_seed_mismatch/,
  );
  await assert.rejects(
    () => recomputeArbitraryColdRetainedEvidence(
      batch,
      recordsAfterRename,
      {
        allowedArtifactRoots: [artifactRoot],
        samplingSeed: 'live-batch-seed',
        expectedBatchReportEvidenceHash: `sha256:${'0'.repeat(64)}`,
      },
    ),
    /external_report_hash_mismatch/,
  );

  const forgedInputSet = structuredClone(batch);
  forgedInputSet.reports[0].runEvidence.inputSetHash = `sha256:${'0'.repeat(64)}`;
  forgedInputSet.reports[0].runEvidence.evidenceHash = rehashEvidence(
    forgedInputSet.reports[0].runEvidence,
  );
  forgedInputSet.summary.attempts[0].runEvidenceHash =
    forgedInputSet.reports[0].runEvidence.evidenceHash;
  forgedInputSet.summary.attempts[0].evidenceHash = rehashEvidence(
    forgedInputSet.summary.attempts[0],
  );
  forgedInputSet.summary.evidenceHash = rehashEvidence(forgedInputSet.summary);
  forgedInputSet.evidenceHash = rehashEvidence(forgedInputSet);
  await assert.rejects(
    () => recomputeArbitraryColdRetainedEvidence(
      forgedInputSet,
      recordsAfterRename,
      {
        allowedArtifactRoots: [artifactRoot],
        samplingSeed: 'live-batch-seed',
        expectedBatchReportEvidenceHash: forgedInputSet.evidenceHash,
      },
    ),
    /run_evidence_invalid/,
  );

  const forgedAuthority = structuredClone(batch);
  forgedAuthority.acceptedForGpuHmr = true;
  forgedAuthority.evidenceHash = rehashEvidence(forgedAuthority);
  await assert.rejects(
    () => recomputeArbitraryColdRetainedEvidence(
      forgedAuthority,
      recordsAfterRename,
      {
        allowedArtifactRoots: [artifactRoot],
        samplingSeed: 'live-batch-seed',
        expectedBatchReportEvidenceHash: forgedAuthority.evidenceHash,
      },
    ),
    /batch_report_invalid/,
  );
  await assert.rejects(
    () => recomputeArbitraryColdRetainedEvidence(
      batch,
      recordsAfterRename.slice(1),
      {
        allowedArtifactRoots: [artifactRoot],
        samplingSeed: 'live-batch-seed',
        expectedBatchReportEvidenceHash: batch.evidenceHash,
      },
    ),
    /selection_invalid/,
  );

  const retainedArtifactPath = batch.reports[0].outputs[0].artifactLocator.storage.localPath;
  const retainedArtifactBytes = await readFile(retainedArtifactPath);
  const forgedArtifactBytes = Buffer.from(retainedArtifactBytes);
  forgedArtifactBytes[0] ^= 0xff;
  try {
    await writeFile(retainedArtifactPath, forgedArtifactBytes);
    await assert.rejects(
      () => recomputeArbitraryColdRetainedEvidence(
        batch,
        recordsAfterRename,
        {
          allowedArtifactRoots: [artifactRoot],
          samplingSeed: 'live-batch-seed',
          expectedBatchReportEvidenceHash: batch.evidenceHash,
        },
      ),
      /artifact_transport_invalid/,
    );
  } finally {
    await writeFile(retainedArtifactPath, retainedArtifactBytes);
  }
  assert.equal(
    (await recomputeArbitraryColdRetainedEvidence(
      batch,
      recordsAfterRename,
      {
        allowedArtifactRoots: [artifactRoot],
        samplingSeed: 'live-batch-seed',
        expectedBatchReportEvidenceHash: batch.evidenceHash,
      },
    )).evidenceHash,
    retainedEvidence.evidenceHash,
  );

  const forgedFacet = structuredClone(retainedEvidence);
  forgedFacet.gpuHmrSuccess = true;
  forgedFacet.evidenceHash = rehashEvidence(forgedFacet);
  assert.throws(
    () => verifyArbitraryColdRetainedEvidence(forgedFacet),
    /retained_evidence_invalid/,
  );

  process.stdout.write(`${JSON.stringify({
    status: 'self_check_passed',
    descriptorCount: recordsAfterRename.length,
    selectedDescriptorHash: batch.selection.selected[0].descriptorHash,
    batchEvidenceHash: batch.summary.evidenceHash,
    retainedEvidenceHash: retainedEvidence.evidenceHash,
    acceptedAsColdBuildEvidence: batch.summary.acceptedAsColdBuildEvidence,
    acceptedForGpuHmr: batch.summary.acceptedForGpuHmr,
    gpuHmrSuccess: batch.summary.gpuHmrSuccess,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
