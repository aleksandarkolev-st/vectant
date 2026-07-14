import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
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
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-arbitrary-cold-batch-'));

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
  assert.equal(batch.reports[0].outputs.length, 1);
  assert.equal(JSON.stringify(batch).includes('renamed-'), false);

  process.stdout.write(`${JSON.stringify({
    status: 'self_check_passed',
    descriptorCount: recordsAfterRename.length,
    selectedDescriptorHash: batch.selection.selected[0].descriptorHash,
    batchEvidenceHash: batch.summary.evidenceHash,
    acceptedAsColdBuildEvidence: batch.summary.acceptedAsColdBuildEvidence,
    acceptedForGpuHmr: batch.summary.acceptedForGpuHmr,
    gpuHmrSuccess: batch.summary.gpuHmrSuccess,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
