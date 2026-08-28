#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GPU_HMR_TEST_TIMING_SCHEMA,
  GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS,
  GpuHmrTestTimingRecorder,
  validateGpuHmrTestTiming,
} from '../lib/gpu-hmr-test-timing-v2.mjs';
import {
  attachRandomLargeColdPathTestTiming,
  buildManifest,
  installRandomLargeColdPathTerminalHandlers,
} from '../gpu-hmr-random-large-project-cold-path.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.resolve(TEST_DIR, '../gpu-hmr-random-large-project-cold-path.mjs');

function advancingClock(initialNs = 0n) {
  let currentNs = initialNs;
  return () => {
    currentNs += 1n;
    return currentNs;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function completeChildTiming(outcome, initialNs, { visualCapable = false } = {}) {
  const recorder = new GpuHmrTestTimingRecorder({ clock: advancingClock(initialNs) });
  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    if (phaseKey === 'total_wall') continue;
    if (!visualCapable && GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.includes(phaseKey)) {
      recorder.notApplicable(phaseKey, 'child_declared_nonvisual');
      continue;
    }
    recorder.startPhase(phaseKey);
    recorder.finishPhase(phaseKey);
  }
  return recorder.finalize({ outcome, visualCapable });
}

function assertParentTiming(record, expectedOutcome, { pending = false } = {}) {
  const validation = validateGpuHmrTestTiming(record);
  assert.equal(validation.valid, true, validation.blockingGaps.join(','));
  assert.equal(record.schema, GPU_HMR_TEST_TIMING_SCHEMA);
  assert.equal(record.authority, 'timing_only');
  assert.equal(record.timingOnly, true);
  assert.equal(record.acceptedForGpuHmr, false);
  assert.equal(record.gpuHmrSuccess, false);
  assert.equal(record.outcome, expectedOutcome);
  assert.equal(record.visualCapable, false);

  assert.equal(record.phases.cold_intake.state, 'unavailable');
  assert.equal(record.phases.discovery.state, 'measured');
  assert.equal(record.phases.compile.state, 'unavailable');
  assert.equal(record.phases.output_ready.state, 'unavailable');
  assert.equal(
    record.phases.output_ready.reasonCode,
    pending
      ? 'random_large_cold_path_execution_pending'
      : 'verified_child_output_ready_not_observed_in_parent_clock_domain',
  );
  assert.equal(record.phases.proof_finalization.state, 'measured');
  assert.equal(record.phases.total_wall.state, 'measured');

  const totalStartNs = BigInt(record.phases.total_wall.startNs);
  const totalEndNs = BigInt(record.phases.total_wall.endNs);
  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    const phase = record.phases[phaseKey];
    assert.ok(['measured', 'unavailable', 'not_applicable'].includes(phase.state));
    if (phase.state === 'measured') {
      assert.ok(BigInt(phase.startNs) >= totalStartNs);
      assert.ok(BigInt(phase.endNs) <= totalEndNs);
      assert.equal(
        BigInt(phase.durationNs),
        BigInt(phase.endNs) - BigInt(phase.startNs),
      );
    } else {
      assert.equal(typeof phase.reasonCode, 'string');
      assert.ok(phase.reasonCode.length > 0);
    }
  }
}

function isolatedRandomColdPathEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SYNTHI_GPU_HMR_LARGE_PROJECT_COLD_')) delete env[key];
  }
  delete env.SYNTHI_GPU_HMR_UNPROFILED_SOURCE_INTAKE;
  delete env.SYNTHI_GPU_HMR_UNPROFILED_SOURCE_INTAKE_TIMEOUT_MS;
  return env;
}

function assertMainRejectionArtifact(
  artifact,
  { expectedStage, expectedDiscoveryState, forbiddenInput },
) {
  assert.equal(artifact.schemaVersion, 'synthi.gpu_hmr.random_large_project_cold_path.v1');
  assert.equal(artifact.eventType, 'cold_path_main_rejected');
  assert.equal(artifact.status, 'failed');
  assert.equal(artifact.lifecycleState, 'failed');
  assert.equal(artifact.acceptedForGpuHmr, false);
  assert.equal(artifact.gpuHmrSuccess, false);
  assert.equal(artifact.canSatisfyRuntimeProof, false);
  assert.deepEqual(artifact.testTiming, artifact.test_timing);

  const retention = artifact.mainRejectionRetention;
  assert.deepEqual(retention, artifact.main_rejection_retention);
  assert.equal(
    retention.schemaVersion,
    'synthi.gpu_hmr.random_large_project_cold_path_main_rejection.v1',
  );
  assert.equal(
    retention.proofAuthority,
    'main_promise_rejection_retention_only_not_gpu_hmr_success',
  );
  assert.equal(retention.terminalStage, expectedStage);
  assert.equal(retention.reasonCode, 'random_large_cold_path_main_promise_rejected');
  assert.equal(retention.acceptedForGpuHmr, false);
  assert.equal(retention.gpuHmrSuccess, false);
  assert.equal(retention.canSatisfyRuntimeProof, false);
  assert.equal(Object.hasOwn(retention, 'error'), false);
  assert.equal(Object.hasOwn(retention, 'message'), false);
  assert.equal(Object.hasOwn(retention, 'stack'), false);

  assert.equal(artifact.results.length, 1);
  assert.equal(artifact.results[0].status, 'main_promise_rejected_failed_closed');
  assert.equal(artifact.results[0].terminalStage, expectedStage);
  assert.equal(artifact.results[0].acceptedForGpuHmr, false);
  assert.equal(artifact.results[0].gpuHmrSuccess, false);
  assert.equal(artifact.results[0].canSatisfyRuntimeProof, false);

  const timing = artifact.testTiming;
  const validation = validateGpuHmrTestTiming(timing);
  assert.equal(validation.valid, true, validation.blockingGaps.join(','));
  assert.equal(timing.schema, GPU_HMR_TEST_TIMING_SCHEMA);
  assert.equal(timing.authority, 'timing_only');
  assert.equal(timing.timingOnly, true);
  assert.equal(timing.outcome, 'failed');
  assert.equal(timing.visualCapable, false);
  assert.equal(timing.acceptedForGpuHmr, false);
  assert.equal(timing.gpuHmrSuccess, false);
  assert.equal(timing.phases.discovery.state, expectedDiscoveryState);
  if (expectedDiscoveryState === 'unavailable') {
    assert.equal(
      timing.phases.discovery.reasonCode,
      'random_large_cold_path_main_promise_rejected',
    );
  }
  assert.equal(timing.phases.proof_finalization.state, 'measured');
  assert.equal(timing.phases.total_wall.state, 'measured');
  assert.ok(BigInt(timing.phases.total_wall.durationNs) > 0n);
  for (const phaseKey of GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS) {
    assert.deepEqual(timing.phases[phaseKey], {
      state: 'not_applicable',
      startNs: null,
      endNs: null,
      durationNs: null,
      reasonCode: 'random_large_cold_path_orchestrator_has_no_visual_observer',
    });
  }
  for (const phase of Object.values(timing.phases)) {
    if (phase.state === 'measured') continue;
    assert.equal(phase.startNs, null);
    assert.equal(phase.endNs, null);
    assert.equal(phase.durationNs, null);
  }

  const serialized = JSON.stringify(artifact);
  assert.doesNotMatch(
    serialized,
    /"(?:acceptedForGpuHmr|accepted_for_gpu_hmr|gpuHmrSuccess|gpu_hmr_success|canSatisfyRuntimeProof|can_satisfy_runtime_proof)":true/,
  );
  if (forbiddenInput) assert.doesNotMatch(serialized, new RegExp(forbiddenInput, 'i'));
}

const validAttachmentTiming = completeChildTiming('refused', 100n);
const validAttachmentTarget = {};
attachRandomLargeColdPathTestTiming(validAttachmentTarget, validAttachmentTiming);
assert.equal(validAttachmentTarget.testTiming, validAttachmentTiming);
assert.equal(validAttachmentTarget.test_timing, validAttachmentTiming);

for (const forgedFields of [
  { authority: 'gpu_hmr_success_authority' },
  { timingOnly: false },
  { acceptedForGpuHmr: true },
  { gpuHmrSuccess: true },
]) {
  const forgedTiming = {
    ...structuredClone(validAttachmentTiming),
    ...forgedFields,
  };
  const target = {};
  assert.throws(
    () => attachRandomLargeColdPathTestTiming(target, forgedTiming),
    /valid support-only timing v2/,
  );
  assert.equal(Object.hasOwn(target, 'testTiming'), false);
  assert.equal(Object.hasOwn(target, 'test_timing'), false);
}

const candidate = {
  id: 'project-neutral-timing-candidate',
  backendFamily: 'unspecified',
  profileMode: 'unprofiled_arbitrary_project_cold_intake',
  candidateSource: 'configured_candidate_pool',
  sourceUrl: 'https://example.invalid/project-neutral.git',
  immutableCommit: '0123456789abcdef0123456789abcdef01234567',
  sizeSignals: {},
  buildSystemHints: {},
  runtimeBoundaryHints: {},
  oracleHints: {},
};

const cases = [
  {
    lifecycleState: 'completed',
    timingOutcome: 'pass',
    childOutcome: 'pass',
    childVisualCapable: true,
    result: { status: 'runner_completed', exitCode: 0 },
  },
  {
    lifecycleState: 'refused',
    timingOutcome: 'refused',
    childOutcome: 'refused',
    result: { status: 'runtime_contract_refused' },
  },
  {
    lifecycleState: 'failed',
    timingOutcome: 'failed',
    childOutcome: 'failed',
    result: { status: 'runner_failed_closed_or_error', exitCode: 7 },
  },
  {
    lifecycleState: 'interrupted',
    timingOutcome: 'failed',
    childOutcome: 'failed',
    result: { status: 'runner_interrupted', signal: 'SIGTERM', timedOut: false },
  },
];

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-random-cold-timing-v2-'));
try {
  for (let index = 0; index < cases.length; index += 1) {
    const testCase = cases[index];
    const childTiming = completeChildTiming(
      testCase.childOutcome,
      BigInt(1000 * (index + 1)),
      { visualCapable: testCase.childVisualCapable === true },
    );
    const persistenceEvents = [];
    const eventSequence = [];
    const baseTimingClock = advancingClock(BigInt(10000 * (index + 1)));
    const timingClock = () => {
      eventSequence.push('clock');
      return baseTimingClock();
    };
    const outputDir = path.join(tmpRoot, testCase.lifecycleState);
    const { manifest, written } = await buildManifest({
      seed: `timing-self-check-${testCase.lifecycleState}`,
      count: 1,
      dryRun: false,
      timeoutMs: 100,
      runnerTimeoutMs: 100,
      sourceIntake: false,
      sourceIntakeTimeoutMs: 100,
      candidates: [candidate],
      outputDir,
      sourceMode: 'configured_candidate_pool',
      timingClock,
      onManifestPersisted: (event) => {
        persistenceEvents.push(event);
        eventSequence.push(event.stage);
      },
      runCandidate: async (selectedCandidate) => ({
        candidateId: selectedCandidate.id,
        ...testCase.result,
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        canSatisfyRuntimeProof: false,
        testTiming: childTiming,
        test_timing: childTiming,
      }),
    });

    assert.equal(manifest.eventType, 'cold_path_complete');
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.lifecycleState, testCase.lifecycleState);
    assert.equal(manifest.lifecycle_state, testCase.lifecycleState);
    assert.equal(manifest.testTiming, manifest.test_timing);
    assertParentTiming(manifest.testTiming, testCase.timingOutcome);

    assert.deepEqual(
      persistenceEvents.map((event) => [event.stage, event.timingAttached]),
      [
        ['pending_outcome', false],
        ['pending_timing', true],
        ['terminal_outcome', false],
        ['terminal_timing', true],
      ],
    );
    assert.equal(persistenceEvents[0].filePath, persistenceEvents[1].filePath);
    assert.equal(persistenceEvents[2].filePath, persistenceEvents[3].filePath);
    for (const [outcomeStage, timingStage] of [
      ['pending_outcome', 'pending_timing'],
      ['terminal_outcome', 'terminal_timing'],
    ]) {
      const outcomeIndex = eventSequence.indexOf(outcomeStage);
      const timingIndex = eventSequence.indexOf(timingStage);
      assert.ok(outcomeIndex >= 0);
      assert.ok(timingIndex > outcomeIndex);
      assert.ok(eventSequence.slice(outcomeIndex + 1, timingIndex).includes('clock'));
    }

    assert.equal(manifest.results[0].testTiming, childTiming);
    assert.equal(manifest.results[0].test_timing, childTiming);
    assert.deepEqual(manifest.results[0].testTiming, childTiming);
    assert.equal(manifest.results[0].testTiming.phases.output_ready.state, 'measured');
    assert.equal(manifest.testTiming.phases.output_ready.state, 'unavailable');
    assert.equal(
      manifest.results[0].testTiming.visualCapable,
      testCase.childVisualCapable === true,
    );

    const pending = JSON.parse(await readFile(manifest.pendingManifestPath, 'utf8'));
    assert.equal(pending.lifecycleState, 'pending');
    assert.equal(pending.lifecycle_state, 'pending');
    assert.deepEqual(pending.testTiming, pending.test_timing);
    assertParentTiming(pending.testTiming, 'refused', { pending: true });
    assert.equal(pending.testTiming.phases.output_ready.state, 'unavailable');
    assert.equal(
      pending.testTiming.phases.output_ready.reasonCode,
      'random_large_cold_path_execution_pending',
    );

    const persisted = JSON.parse(await readFile(written.filePath, 'utf8'));
    assert.deepEqual(persisted.results[0].testTiming, childTiming);
    assert.deepEqual(persisted.results[0].test_timing, childTiming);
    assert.deepEqual(persisted.testTiming, manifest.testTiming);
  }

  const candidateStarted = deferred();
  const releaseCandidate = deferred();
  let retainParentTerminal = null;
  const retentionPersistenceEvents = [];
  const interruptedBuild = buildManifest({
    seed: 'parent-terminal-retention',
    count: 1,
    dryRun: false,
    timeoutMs: 100,
    runnerTimeoutMs: 100,
    sourceIntake: false,
    sourceIntakeTimeoutMs: 100,
    candidates: [candidate],
    outputDir: path.join(tmpRoot, 'parent-terminal-retention'),
    sourceMode: 'configured_candidate_pool',
    registerTerminalRetention: (retain) => {
      retainParentTerminal = retain;
    },
    onManifestPersisted: (event) => retentionPersistenceEvents.push(event),
    runCandidate: async (selectedCandidate) => {
      candidateStarted.resolve();
      await releaseCandidate.promise;
      return {
        candidateId: selectedCandidate.id,
        status: 'runner_completed',
        exitCode: 0,
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
        canSatisfyRuntimeProof: false,
      };
    },
  });
  await candidateStarted.promise;
  assert.equal(typeof retainParentTerminal, 'function');
  const retainedInterruption = await retainParentTerminal({
    kind: 'signal',
    signal: 'SIGTERM',
  });
  assert.equal(retainedInterruption.manifest.eventType, 'cold_path_interrupted');
  assert.equal(retainedInterruption.manifest.lifecycleState, 'interrupted');
  assert.equal(retainedInterruption.manifest.results.length, 1);
  assert.equal(
    retainedInterruption.manifest.results[0].status,
    'parent_sigterm_interrupted',
  );
  assert.equal(retainedInterruption.manifest.results[0].signal, 'SIGTERM');
  assert.equal(retainedInterruption.manifest.results[0].acceptedForGpuHmr, false);
  assert.equal(retainedInterruption.manifest.results[0].gpuHmrSuccess, false);
  assert.equal(retainedInterruption.manifest.results[0].canSatisfyRuntimeProof, false);
  assertParentTiming(retainedInterruption.manifest.testTiming, 'failed');
  assert.deepEqual(
    retentionPersistenceEvents
      .filter((event) => event.stage.startsWith('parent_terminal'))
      .map((event) => [event.stage, event.timingAttached]),
    [
      ['parent_terminal_outcome', false],
      ['parent_terminal_timing', true],
    ],
  );
  const persistedInterruption = JSON.parse(
    await readFile(retainedInterruption.written.filePath, 'utf8'),
  );
  assert.deepEqual(persistedInterruption.testTiming, retainedInterruption.manifest.testTiming);
  releaseCandidate.resolve();
  await interruptedBuild;

  for (const [eventName, emittedArgs, expected] of [
    ['SIGINT', [], { kind: 'signal', signal: 'SIGINT', exitCode: 130 }],
    ['SIGTERM', [], { kind: 'signal', signal: 'SIGTERM', exitCode: 143 }],
    [
      'uncaughtException',
      [Object.assign(new Error('must-not-enter-retained-output'), { name: 'ProbeException' })],
      { kind: 'unhandled_error', signal: null, exitCode: 1, errorName: 'ProbeException' },
    ],
    [
      'unhandledRejection',
      [Object.assign(new Error('must-not-enter-retained-output'), { name: 'ProbeRejection' })],
      { kind: 'unhandled_error', signal: null, exitCode: 1, errorName: 'ProbeRejection' },
    ],
  ]) {
    const processTarget = new EventEmitter();
    const retainedEvents = [];
    const exitCodes = [];
    const reportedErrors = [];
    const handlers = installRandomLargeColdPathTerminalHandlers({
      processTarget,
      retainTerminal: async (event) => retainedEvents.push(event),
      exitProcess: (code) => exitCodes.push(code),
      reportError: (error) => reportedErrors.push(error),
    });
    processTarget.emit(eventName, ...emittedArgs);
    processTarget.emit(eventName, ...emittedArgs);
    await handlers.waitForTerminal();
    assert.equal(retainedEvents.length, 1);
    assert.equal(retainedEvents[0].kind, expected.kind);
    assert.equal(retainedEvents[0].signal, expected.signal);
    assert.equal(retainedEvents[0].errorName, expected.errorName ?? null);
    assert.deepEqual(exitCodes, [expected.exitCode]);
    assert.deepEqual(reportedErrors, []);
    handlers.dispose();
  }

  const mainRejectionCases = [
    {
      name: 'bad-args',
      args: (outputDir) => [
        '--unknown-timing-v2-argument',
        '--output-dir',
        outputDir,
      ],
      expectedStage: 'cli_argument_parsing',
      expectedDiscoveryState: 'unavailable',
      expectedError: /unknown argument: --unknown-timing-v2-argument/,
      forbiddenInput: 'unknown-timing-v2-argument',
    },
    {
      name: 'bad-source',
      args: (outputDir) => [
        '--source-url',
        'https://example.invalid/generic-cold-source.git',
        '--output-dir',
        outputDir,
      ],
      expectedStage: 'source_configuration',
      expectedDiscoveryState: 'unavailable',
      expectedError: /requires --source-url or --repo-path plus --commit/,
      forbiddenInput: 'generic-cold-source',
    },
    {
      name: 'later-main-rejection',
      args: (outputDir) => [
        '--sample-pool',
        '--dry-run',
        '--candidate',
        'missing-neutral-candidate',
        '--output-dir',
        outputDir,
      ],
      expectedStage: 'manifest_execution',
      expectedDiscoveryState: 'measured',
      expectedError: /candidate not found: missing-neutral-candidate/,
      forbiddenInput: 'missing-neutral-candidate',
    },
  ];
  for (const testCase of mainRejectionCases) {
    const outputDir = path.join(tmpRoot, `main-rejection-${testCase.name}`);
    const child = spawnSync(
      process.execPath,
      [RUNNER_PATH, ...testCase.args(outputDir)],
      {
        cwd: path.dirname(RUNNER_PATH),
        encoding: 'utf8',
        env: isolatedRandomColdPathEnv(),
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30000,
      },
    );
    assert.equal(
      child.status,
      1,
      `${testCase.name} did not reject\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
    );
    assert.match(child.stderr, testCase.expectedError);
    const retainedNames = (await readdir(outputDir))
      .filter((name) => name.endsWith('-main-rejected.json'));
    assert.equal(retainedNames.length, 1, `${testCase.name}: ${retainedNames.join(',')}`);
    const artifact = JSON.parse(await readFile(path.join(outputDir, retainedNames[0]), 'utf8'));
    assertMainRejectionArtifact(artifact, testCase);
  }

  const runnerSource = await readFile(RUNNER_PATH, 'utf8');
  const runtimeStart = runnerSource.indexOf('function createRandomLargeColdPathMainRuntime');
  const runtimeEnd = runnerSource.indexOf('function normalizedMainRejectionErrorName', runtimeStart);
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart);
  const runtimeSource = runnerSource.slice(runtimeStart, runtimeEnd);
  assert.ok(
    runtimeSource.indexOf('createRandomLargeColdPathTimingCoordinator')
      < runtimeSource.indexOf('options.argv'),
    'canonical timing must be created before CLI input is read',
  );
  assert.ok(
    runtimeSource.indexOf('createRandomLargeColdPathTimingCoordinator')
      < runtimeSource.indexOf('randomLargeColdPathOutputDirFromRawInput'),
    'canonical timing must be created before bootstrap output parsing',
  );
  const retentionEnd = runnerSource.indexOf('export async function buildManifest', runtimeEnd);
  assert.ok(retentionEnd > runtimeEnd);
  const retentionSource = runnerSource.slice(runtimeStart, retentionEnd);
  assert.doesNotMatch(
    retentionSource,
    /\b(?:project|profile|fixture|target)(?:Id|Name)?\b\s*(?:===|==|!==|!=)/i,
  );
  assert.doesNotMatch(
    retentionSource,
    /\b(?:acceptedForGpuHmr|gpuHmrSuccess|canSatisfyRuntimeProof)\s*:\s*true\b/,
  );
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok: true,
  schema: GPU_HMR_TEST_TIMING_SCHEMA,
  lifecycleStates: ['pending', ...cases.map((testCase) => testCase.lifecycleState)],
  childTimingPreserved: true,
  rejectedMainCases: ['bad_args', 'bad_source', 'later_rejection'],
  genericFailureRetention: true,
  proofAuthorityGranted: false,
}, null, 2));
