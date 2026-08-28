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
  ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON,
  attachArbitraryColdProjectBatchTestTiming,
  createArbitraryColdProjectBatchFailure,
  createArbitraryColdProjectBatchTimingRecorder,
  runArbitraryColdProjectBatch,
  verifyArbitraryColdProjectBatchFailure,
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
  verifyRetainedArbitraryColdBatchSelection,
  verifyRetainedArbitraryColdBatchSummary,
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
import {
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GPU_HMR_TEST_TIMING_SCHEMA,
  GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS,
  validateGpuHmrTestTiming,
} from '../lib/gpu-hmr-test-timing-v2.mjs';

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

function controlledClock(initialNs = 0n) {
  let currentNs = initialNs;
  return {
    now: () => currentNs,
    tick: (durationNs = 1n) => {
      currentNs += durationNs;
      return currentNs;
    },
  };
}

function assertSupportOnlyTiming(
  record,
  expectedOutcome,
  { expectedVisualReason = null } = {},
) {
  const validation = validateGpuHmrTestTiming(record);
  assert.equal(validation.valid, true, validation.blockingGaps.join(','));
  assert.equal(record.schema, GPU_HMR_TEST_TIMING_SCHEMA);
  assert.equal(record.clock, 'monotonic_ns');
  assert.equal(record.authority, 'timing_only');
  assert.equal(record.timingOnly, true);
  assert.equal(record.acceptedForGpuHmr, false);
  assert.equal(record.gpuHmrSuccess, false);
  assert.equal(record.outcome, expectedOutcome);
  assert.equal(record.visualCapable, false);
  assert.equal(record.phases.total_wall.state, 'measured');
  const totalStartNs = BigInt(record.phases.total_wall.startNs);
  const totalEndNs = BigInt(record.phases.total_wall.endNs);
  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    const phase = record.phases[phaseKey];
    assert.ok(phase, `timing phase ${phaseKey} must be present`);
    if (phase.state === 'measured') {
      assert.equal(phase.reasonCode, null);
      assert.ok(BigInt(phase.startNs) >= totalStartNs);
      assert.ok(BigInt(phase.endNs) <= totalEndNs);
      assert.equal(
        BigInt(phase.durationNs),
        BigInt(phase.endNs) - BigInt(phase.startNs),
      );
    } else {
      assert.ok(['unavailable', 'not_applicable'].includes(phase.state));
      assert.equal(phase.startNs, null);
      assert.equal(phase.endNs, null);
      assert.equal(phase.durationNs, null);
      assert.match(phase.reasonCode, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
    }
  }
  for (const phaseKey of GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS) {
    assert.equal(record.phases[phaseKey].state, 'not_applicable');
    if (expectedVisualReason !== null) {
      assert.equal(record.phases[phaseKey].reasonCode, expectedVisualReason);
    }
  }
  return record;
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

  const batchClock = controlledClock(10_000n);
  const terminalSnapshots = [];
  const batch = await runArbitraryColdProjectBatch({
    descriptorRoot,
    artifactRoot,
    sampleCount: 1,
    seed: 'live-batch-seed',
    timingClock: batchClock.now,
    persistTerminalSnapshot: async (snapshot) => {
      const persistedThroughNs = batchClock.tick(17n);
      terminalSnapshots.push({
        snapshot: structuredClone(snapshot),
        persistedThroughNs,
      });
    },
  });
  assert.equal(batch.schemaVersion, ARBITRARY_COLD_BATCH_REPORT_SCHEMA);
  assert.equal(batch.proofAuthority, ARBITRARY_COLD_BATCH_REPORT_AUTHORITY);
  assert.equal(batch.acceptedAsColdBuildEvidence, false);
  assert.equal(batch.acceptedForGpuHmr, false);
  assert.equal(batch.gpuHmrSuccess, false);
  assert.equal(batch.canSatisfyRuntimeProof, false);
  assert.equal(batch.canSatisfyDispatchProof, false);
  assert.equal(batch.terminalOutcome, 'completed');
  assert.equal(batch.terminal_outcome, 'completed');
  assert.equal(batch.testTiming, batch.test_timing);
  assertSupportOnlyTiming(batch.testTiming, 'pass', {
    expectedVisualReason: ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON,
  });
  assert.equal(batch.reports[0].terminalOutcome, 'completed');
  assert.equal(batch.reports[0].testTiming, batch.reports[0].test_timing);
  assertSupportOnlyTiming(batch.reports[0].testTiming, 'pass', {
    expectedVisualReason: ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON,
  });
  assert.equal(
    batch.reports[0].childTestTiming,
    batch.reports[0].child_test_timing,
  );
  assertSupportOnlyTiming(batch.reports[0].childTestTiming, 'pass');
  assert.equal(
    batch.summary.attempts[0].testTiming,
    batch.reports[0].testTiming,
  );
  assert.equal(
    batch.summary.attempts[0].childTestTiming,
    batch.reports[0].childTestTiming,
  );
  assert.equal(batch.summary.attempts[0].terminalOutcome, 'completed');
  assert.equal(Object.keys(batch).includes('testTiming'), false);
  assert.equal(Object.keys(batch.reports[0]).includes('childTestTiming'), false);
  assert.equal(Object.keys(batch.summary.attempts[0]).includes('testTiming'), false);
  assert.deepEqual(
    terminalSnapshots.map(({ snapshot }) => snapshot.scope),
    ['attempt', 'batch'],
  );
  assert.ok(
    BigInt(batch.reports[0].testTiming.phases.total_wall.endNs)
      >= terminalSnapshots[0].persistedThroughNs,
  );
  assert.ok(
    BigInt(batch.testTiming.phases.total_wall.endNs)
      >= terminalSnapshots[1].persistedThroughNs,
  );
  assert.equal(verifyArbitraryColdProjectBatchReport(batch), batch);
  assert.equal(
    verifyRetainedArbitraryColdBatchSelection(batch.selection),
    batch.selection,
  );
  assert.equal(
    verifyRetainedArbitraryColdBatchSummary(batch.summary, batch.selection),
    batch.summary,
  );
  const serializedTimedBatch = JSON.parse(JSON.stringify(batch));
  assert.equal(serializedTimedBatch.terminalOutcome, 'completed');
  assert.equal(
    serializedTimedBatch.testTiming.schema,
    GPU_HMR_TEST_TIMING_SCHEMA,
  );
  assert.equal(
    serializedTimedBatch.reports[0].childTestTiming.schema,
    GPU_HMR_TEST_TIMING_SCHEMA,
  );
  assert.deepEqual(
    serializedTimedBatch.summary.attempts[0].testTiming,
    serializedTimedBatch.reports[0].testTiming,
  );
  assert.deepEqual(
    serializedTimedBatch.summary.attempts[0].childTestTiming,
    serializedTimedBatch.reports[0].childTestTiming,
  );
  assert.equal(
    verifyArbitraryColdProjectBatchReport(serializedTimedBatch),
    serializedTimedBatch,
  );

  const forgedTimingAlias = structuredClone(serializedTimedBatch);
  forgedTimingAlias.reports[0].test_timing.outcome = 'failed';
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedTimingAlias),
    /batch_report_invalid/,
  );
  const forgedChildTimingAlias = structuredClone(serializedTimedBatch);
  forgedChildTimingAlias.reports[0].child_test_timing.outcome = 'failed';
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedChildTimingAlias),
    /batch_report_invalid/,
  );
  const forgedSummaryChildTimingAlias = structuredClone(serializedTimedBatch);
  forgedSummaryChildTimingAlias.summary.attempts[0].child_test_timing.outcome = 'failed';
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedSummaryChildTimingAlias),
    /batch_report_invalid/,
  );
  const forgedChildTimingAuthority = structuredClone(serializedTimedBatch);
  forgedChildTimingAuthority.reports[0].childTestTiming.authority =
    'gpu_hmr_success_authority';
  forgedChildTimingAuthority.reports[0].child_test_timing.authority =
    'gpu_hmr_success_authority';
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedChildTimingAuthority),
    /batch_report_invalid/,
  );
  const forgedBatchTimingAuthority = structuredClone(serializedTimedBatch);
  forgedBatchTimingAuthority.testTiming.acceptedForGpuHmr = true;
  forgedBatchTimingAuthority.test_timing.acceptedForGpuHmr = true;
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedBatchTimingAuthority),
    /batch_report_invalid/,
  );
  const forgedBatch = structuredClone(batch);
  forgedBatch.acceptedForGpuHmr = true;
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedBatch),
    /batch_report_invalid/,
  );

  const forgedSelectionAuthority = structuredClone(batch);
  forgedSelectionAuthority.selection.proofAuthority = 'forged_selection_authority';
  forgedSelectionAuthority.selection.evidenceHash = rehashEvidence(
    forgedSelectionAuthority.selection,
  );
  forgedSelectionAuthority.summary.selectionEvidenceHash =
    forgedSelectionAuthority.selection.evidenceHash;
  forgedSelectionAuthority.summary.attempts[0].selectionEvidenceHash =
    forgedSelectionAuthority.selection.evidenceHash;
  forgedSelectionAuthority.summary.attempts[0].evidenceHash = rehashEvidence(
    forgedSelectionAuthority.summary.attempts[0],
  );
  forgedSelectionAuthority.summary.evidenceHash = rehashEvidence(
    forgedSelectionAuthority.summary,
  );
  forgedSelectionAuthority.evidenceHash = rehashEvidence(forgedSelectionAuthority);
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedSelectionAuthority),
    /batch_report_invalid/,
  );

  const forgedSelectionScore = structuredClone(batch);
  forgedSelectionScore.selection.selected[0].selectionScore = `sha256:${'3'.repeat(64)}`;
  forgedSelectionScore.selection.evidenceHash = rehashEvidence(forgedSelectionScore.selection);
  forgedSelectionScore.summary.selectionEvidenceHash =
    forgedSelectionScore.selection.evidenceHash;
  forgedSelectionScore.summary.attempts[0].selectionScore =
    forgedSelectionScore.selection.selected[0].selectionScore;
  forgedSelectionScore.summary.attempts[0].selectionEvidenceHash =
    forgedSelectionScore.selection.evidenceHash;
  forgedSelectionScore.summary.attempts[0].evidenceHash = rehashEvidence(
    forgedSelectionScore.summary.attempts[0],
  );
  forgedSelectionScore.summary.evidenceHash = rehashEvidence(forgedSelectionScore.summary);
  forgedSelectionScore.evidenceHash = rehashEvidence(forgedSelectionScore);
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedSelectionScore),
    /batch_report_invalid/,
  );

  const forgedSummaryCounts = structuredClone(batch);
  forgedSummaryCounts.summary.completedColdRunCount = 0;
  forgedSummaryCounts.summary.refusedColdRunCount = 1;
  forgedSummaryCounts.summary.evidenceHash = rehashEvidence(forgedSummaryCounts.summary);
  forgedSummaryCounts.evidenceHash = rehashEvidence(forgedSummaryCounts);
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedSummaryCounts),
    /batch_report_invalid/,
  );

  const forgedAttemptAuthority = structuredClone(batch);
  forgedAttemptAuthority.summary.attempts[0].gpuHmrSuccess = true;
  forgedAttemptAuthority.summary.attempts[0].evidenceHash = rehashEvidence(
    forgedAttemptAuthority.summary.attempts[0],
  );
  forgedAttemptAuthority.summary.evidenceHash = rehashEvidence(
    forgedAttemptAuthority.summary,
  );
  forgedAttemptAuthority.evidenceHash = rehashEvidence(forgedAttemptAuthority);
  assert.throws(
    () => verifyArbitraryColdProjectBatchReport(forgedAttemptAuthority),
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

  const terminalCases = [
    {
      name: 'refused',
      failureCode: 'arbitrary_cold_batch_self_check_refused',
      terminalOutcome: 'refused',
      timingOutcome: 'refused',
    },
    {
      name: 'failed',
      failureCode: 'arbitrary_cold_batch_self_check_failed',
      terminalOutcome: 'failed',
      timingOutcome: 'failed',
    },
  ];
  for (const [index, terminalCase] of terminalCases.entries()) {
    const terminalClock = controlledClock(20_000n + BigInt(index * 1_000));
    const caseSnapshots = [];
    const terminalBatch = await runArbitraryColdProjectBatch({
      descriptorRoot,
      artifactRoot,
      sampleCount: 1,
      seed: `terminal-${terminalCase.name}-seed`,
      timingClock: terminalClock.now,
      runProject: async () => {
        throw new Error(terminalCase.failureCode);
      },
      persistTerminalSnapshot: async (snapshot) => {
        const persistedThroughNs = terminalClock.tick(13n);
        caseSnapshots.push({
          snapshot: structuredClone(snapshot),
          persistedThroughNs,
        });
      },
    });
    assert.equal(terminalBatch.summary.completedColdRunCount, 0);
    assert.equal(terminalBatch.summary.refusedColdRunCount, 1);
    assert.equal(terminalBatch.reports[0].outcome, 'cold_run_refused');
    assert.equal(terminalBatch.reports[0].terminalOutcome, terminalCase.terminalOutcome);
    assert.equal(terminalBatch.terminalOutcome, terminalCase.terminalOutcome);
    assert.equal(
      terminalBatch.summary.attempts[0].terminalOutcome,
      terminalCase.terminalOutcome,
    );
    assert.equal(
      terminalBatch.summary.attempts[0].testTiming,
      terminalBatch.reports[0].testTiming,
    );
    assertSupportOnlyTiming(
      terminalBatch.reports[0].testTiming,
      terminalCase.timingOutcome,
      { expectedVisualReason: ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON },
    );
    assertSupportOnlyTiming(
      terminalBatch.testTiming,
      terminalCase.timingOutcome,
      { expectedVisualReason: ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON },
    );
    assertSupportOnlyTiming(
      terminalBatch.reports[0].childTestTiming,
      terminalCase.timingOutcome,
    );
    assert.deepEqual(
      terminalBatch.reports[0].childTestTiming,
      terminalBatch.reports[0].failureEvidence.testTiming,
    );
    assert.deepEqual(
      caseSnapshots.map(({ snapshot }) => snapshot.scope),
      ['attempt', 'batch'],
    );
    assert.ok(
      BigInt(terminalBatch.reports[0].testTiming.phases.total_wall.endNs)
        >= caseSnapshots[0].persistedThroughNs,
    );
    assert.ok(
      BigInt(terminalBatch.testTiming.phases.total_wall.endNs)
        >= caseSnapshots[1].persistedThroughNs,
    );
    const serializedTerminalBatch = JSON.parse(JSON.stringify(terminalBatch));
    assert.equal(
      verifyArbitraryColdProjectBatchReport(serializedTerminalBatch),
      serializedTerminalBatch,
    );
  }

  const topLevelClock = controlledClock(30_000n);
  const topLevelTimingRecorder = createArbitraryColdProjectBatchTimingRecorder({
    clock: topLevelClock.now,
    scope: 'top_level',
  });
  topLevelClock.tick(5n);
  let topLevelPersistedThroughNs = null;
  const topLevelFailure = await createArbitraryColdProjectBatchFailure(
    new Error('arbitrary_cold_batch_top_level_runtime_failed'),
    {
      timingRecorder: topLevelTimingRecorder,
      persistTerminalSnapshot: async (snapshot) => {
        assert.equal(snapshot.scope, 'top_level');
        assert.equal(snapshot.terminalOutcome, 'failed');
        topLevelPersistedThroughNs = topLevelClock.tick(19n);
      },
    },
  );
  assert.equal(topLevelFailure.terminalOutcome, 'failed');
  assertSupportOnlyTiming(topLevelFailure.testTiming, 'failed', {
    expectedVisualReason: ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON,
  });
  assert.ok(
    BigInt(topLevelFailure.testTiming.phases.total_wall.endNs)
      >= topLevelPersistedThroughNs,
  );
  assert.equal(
    verifyArbitraryColdProjectBatchFailure(topLevelFailure),
    topLevelFailure,
  );
  const serializedTopLevelFailure = JSON.parse(JSON.stringify(topLevelFailure));
  assert.equal(
    verifyArbitraryColdProjectBatchFailure(serializedTopLevelFailure),
    serializedTopLevelFailure,
  );

  const forgedAttachmentTiming = structuredClone(batch.testTiming);
  forgedAttachmentTiming.authority = 'gpu_hmr_success_authority';
  assert.throws(
    () => attachArbitraryColdProjectBatchTestTiming(
      {},
      forgedAttachmentTiming,
      { terminalOutcome: 'completed' },
    ),
    /timing_invalid/,
  );
  assert.throws(
    () => attachArbitraryColdProjectBatchTestTiming(
      { testTiming: batch.testTiming },
      batch.testTiming,
      { terminalOutcome: 'completed' },
    ),
    /timing_aliases_invalid/,
  );

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
    timingSchema: batch.testTiming.schema,
    terminalOutcomes: ['completed', ...terminalCases.map((entry) => entry.terminalOutcome)],
    persistedTerminalSnapshotIncludedInTotalWall: true,
    childTimingPreserved: true,
    acceptedAsColdBuildEvidence: batch.summary.acceptedAsColdBuildEvidence,
    acceptedForGpuHmr: batch.summary.acceptedForGpuHmr,
    gpuHmrSuccess: batch.summary.gpuHmrSuccess,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
