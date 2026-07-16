import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createArbitraryColdProjectRunFailure,
  runArbitraryColdProject,
  verifyArbitraryColdProjectRun,
  verifyArbitraryColdProjectRunFailure,
} from './gpu-hmr-arbitrary-cold-project-runner.mjs';
import {
  createArbitraryColdBatchSummary,
  createCompletedArbitraryColdBatchAttempt,
  createRefusedArbitraryColdBatchAttempt,
  discoverArbitraryColdProjectDescriptors,
  selectArbitraryColdProjectDescriptors,
  verifyArbitraryColdBatchSelection,
  verifyRetainedArbitraryColdBatchSelection,
  verifyRetainedArbitraryColdBatchSummary,
} from './lib/gpu-hmr-arbitrary-cold-project-batch.mjs';
import {
  createArbitraryColdCliResultEnvelope,
} from './lib/gpu-hmr-arbitrary-cold-cli-envelope.mjs';
import {
  verifyArbitraryColdRetainedExecutionChain,
} from './lib/gpu-hmr-arbitrary-cold-retained-chain.mjs';
import {
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GPU_HMR_TEST_TIMING_SCHEMA,
  GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS,
  GpuHmrTestTimingRecorder,
  validateGpuHmrTestTiming,
} from './lib/gpu-hmr-test-timing-v2.mjs';

const CLI_KEYS = new Set([
  '--artifact-root',
  '--descriptor-root',
  '--docker',
  '--sample-count',
  '--seed',
]);

export const ARBITRARY_COLD_BATCH_REPORT_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_batch_report.v2';
export const ARBITRARY_COLD_BATCH_REPORT_AUTHORITY =
  'batch_report_transport_only_not_cold_build_or_gpu_hmr_success';
export const ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON =
  'arbitrary_cold_batch_has_no_visual_observer';

const ARBITRARY_COLD_BATCH_TIMING_SPLIT_NOT_APPLICABLE_REASON =
  'arbitrary_cold_batch_does_not_perform_split';
const ARBITRARY_COLD_BATCH_TIMING_RUNTIME_NOT_APPLICABLE_REASON =
  'arbitrary_cold_batch_does_not_perform_gpu_hmr_runtime_phase';
const ARBITRARY_COLD_BATCH_TIMING_PHASE_UNAVAILABLE_REASON =
  'child_phase_boundary_not_observed_by_batch_clock';
const ARBITRARY_COLD_ATTEMPT_TIMING_PHASE_UNAVAILABLE_REASON =
  'child_phase_boundary_not_observed_by_attempt_clock';
const ARBITRARY_COLD_TOP_LEVEL_TIMING_PHASE_UNAVAILABLE_REASON =
  'batch_phase_boundary_not_observed_before_top_level_terminal';
const ARBITRARY_COLD_BATCH_TERMINAL_SNAPSHOT_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_batch_terminal_snapshot.v1';
const ARBITRARY_COLD_BATCH_TERMINAL_SNAPSHOT_AUTHORITY =
  'terminal_persistence_checkpoint_only_not_cold_build_or_gpu_hmr_success';
const ARBITRARY_COLD_BATCH_FAILURE_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_batch_failure.v1';
const ARBITRARY_COLD_BATCH_FAILURE_AUTHORITY =
  'batch_failure_diagnostics_only_not_cold_build_or_gpu_hmr_success';
const TERMINAL_OUTCOMES = new Set(['completed', 'refused', 'failed']);
const TIMING_TRANSPORT_KEYS = new Set([
  'testTiming',
  'test_timing',
  'childTestTiming',
  'child_test_timing',
  'terminalOutcome',
  'terminal_outcome',
]);
const TIMING_RECORDER_SCOPES = new WeakMap();

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
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function exactCanonicalKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(
      Object.keys(value).filter((key) => !TIMING_TRANSPORT_KEYS.has(key)).sort(),
    ) === stableJson([...keys].sort());
}

function timingOutcomeForTerminal(terminalOutcome) {
  if (terminalOutcome === 'completed') return 'pass';
  if (terminalOutcome === 'refused') return 'refused';
  if (terminalOutcome === 'failed') return 'failed';
  throw new Error('arbitrary_cold_batch_terminal_outcome_invalid');
}

function terminalReasonForOutcome(terminalOutcome, scope) {
  return `arbitrary_cold_${scope}_${terminalOutcome}`;
}

function assertSupportOnlyTiming(testTiming, {
  expectedVisualReason = null,
  outcomes = ['pass', 'refused', 'failed'],
} = {}) {
  const validation = validateGpuHmrTestTiming(testTiming);
  if (
    testTiming?.schema !== GPU_HMR_TEST_TIMING_SCHEMA
    || validation.valid !== true
    || testTiming.authority !== 'timing_only'
    || testTiming.timingOnly !== true
    || testTiming.acceptedForGpuHmr !== false
    || testTiming.gpuHmrSuccess !== false
    || testTiming.visualCapable !== false
    || !outcomes.includes(testTiming.outcome)
    || GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.some((phaseKey) => (
      testTiming.phases?.[phaseKey]?.state !== 'not_applicable'
      || testTiming.phases?.[phaseKey]?.startNs !== null
      || testTiming.phases?.[phaseKey]?.endNs !== null
      || testTiming.phases?.[phaseKey]?.durationNs !== null
      || typeof testTiming.phases?.[phaseKey]?.reasonCode !== 'string'
      || testTiming.phases[phaseKey].reasonCode.length < 1
      || (
        expectedVisualReason !== null
        && testTiming.phases[phaseKey].reasonCode !== expectedVisualReason
      )
    ))
  ) {
    throw new Error('arbitrary_cold_batch_timing_invalid');
  }
  return testTiming;
}

function timingAlias(target, camelKey, snakeKey, { required = true } = {}) {
  const hasCamel = Object.hasOwn(target ?? {}, camelKey);
  const hasSnake = Object.hasOwn(target ?? {}, snakeKey);
  if (!hasCamel && !hasSnake && !required) return null;
  if (
    !hasCamel
    || !hasSnake
    || stableJson(target[camelKey]) !== stableJson(target[snakeKey])
  ) {
    throw new Error('arbitrary_cold_batch_timing_aliases_invalid');
  }
  return target[camelKey];
}

function defineTransportValue(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: false,
    writable: false,
    value,
  });
}

function timingTransportToJSON() {
  const projection = { ...this };
  for (const key of TIMING_TRANSPORT_KEYS) {
    if (Object.hasOwn(this, key)) projection[key] = this[key];
  }
  return projection;
}

export function attachArbitraryColdProjectBatchTestTiming(
  target,
  testTiming,
  { terminalOutcome, childTestTiming = null } = {},
) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new TypeError('arbitrary cold batch timing target must be an object');
  }
  if (Object.hasOwn(target, 'toJSON') && target.toJSON !== timingTransportToJSON) {
    throw new TypeError('arbitrary cold batch timing transport serializer is invalid');
  }
  if (!TERMINAL_OUTCOMES.has(terminalOutcome)) {
    throw new TypeError('arbitrary cold batch terminal outcome is invalid');
  }
  assertSupportOnlyTiming(testTiming, {
    expectedVisualReason: ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON,
    outcomes: [timingOutcomeForTerminal(terminalOutcome)],
  });
  if (childTestTiming !== null) assertSupportOnlyTiming(childTestTiming);

  const existingTiming = timingAlias(target, 'testTiming', 'test_timing', {
    required: false,
  });
  if (existingTiming !== null && stableJson(existingTiming) !== stableJson(testTiming)) {
    throw new TypeError('arbitrary cold batch timing aliases do not match');
  }
  const existingTerminal = timingAlias(
    target,
    'terminalOutcome',
    'terminal_outcome',
    { required: false },
  );
  if (existingTerminal !== null && existingTerminal !== terminalOutcome) {
    throw new TypeError('arbitrary cold batch terminal outcome aliases do not match');
  }
  const existingChild = timingAlias(
    target,
    'childTestTiming',
    'child_test_timing',
    { required: false },
  );
  const hasExistingChild = Object.hasOwn(target, 'childTestTiming');
  if (
    hasExistingChild
    && (
      childTestTiming === null
      || stableJson(existingChild) !== stableJson(childTestTiming)
    )
  ) {
    throw new TypeError('arbitrary cold batch child timing aliases do not match');
  }

  if (existingTiming === null) {
    defineTransportValue(target, 'testTiming', testTiming);
    defineTransportValue(target, 'test_timing', testTiming);
  }
  if (existingTerminal === null) {
    defineTransportValue(target, 'terminalOutcome', terminalOutcome);
    defineTransportValue(target, 'terminal_outcome', terminalOutcome);
  }
  if (childTestTiming !== null && existingChild === null) {
    defineTransportValue(target, 'childTestTiming', childTestTiming);
    defineTransportValue(target, 'child_test_timing', childTestTiming);
  }
  if (!Object.hasOwn(target, 'toJSON')) {
    Object.defineProperty(target, 'toJSON', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: timingTransportToJSON,
    });
  }
  return target;
}

function verifyTimingTransport(target, {
  allowedTerminalOutcomes,
  childTimingRequired = false,
} = {}) {
  const testTiming = timingAlias(target, 'testTiming', 'test_timing');
  const terminalOutcome = timingAlias(target, 'terminalOutcome', 'terminal_outcome');
  const childTestTiming = timingAlias(
    target,
    'childTestTiming',
    'child_test_timing',
    { required: childTimingRequired },
  );
  if (!allowedTerminalOutcomes.includes(terminalOutcome)) {
    throw new Error('arbitrary_cold_batch_terminal_outcome_invalid');
  }
  assertSupportOnlyTiming(testTiming, {
    expectedVisualReason: ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON,
    outcomes: [timingOutcomeForTerminal(terminalOutcome)],
  });
  if (childTestTiming !== null) assertSupportOnlyTiming(childTestTiming);
  return { testTiming, terminalOutcome, childTestTiming };
}

export function createArbitraryColdProjectBatchTimingRecorder({
  clock = () => process.hrtime.bigint(),
  scope = 'batch',
} = {}) {
  if (!['batch', 'attempt', 'top_level'].includes(scope)) {
    throw new TypeError('arbitrary cold batch timing scope is invalid');
  }
  const recorder = new GpuHmrTestTimingRecorder({ clock });
  const observedPhases = new Set(
    scope === 'batch' ? ['discovery', 'proof_finalization'] : ['proof_finalization'],
  );
  const unavailableReason = scope === 'batch'
    ? ARBITRARY_COLD_BATCH_TIMING_PHASE_UNAVAILABLE_REASON
    : scope === 'attempt'
      ? ARBITRARY_COLD_ATTEMPT_TIMING_PHASE_UNAVAILABLE_REASON
      : ARBITRARY_COLD_TOP_LEVEL_TIMING_PHASE_UNAVAILABLE_REASON;
  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    if (phaseKey === 'total_wall' || observedPhases.has(phaseKey)) continue;
    if (GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.includes(phaseKey)) {
      recorder.notApplicable(
        phaseKey,
        ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON,
      );
    } else if (phaseKey === 'split') {
      recorder.notApplicable(
        phaseKey,
        ARBITRARY_COLD_BATCH_TIMING_SPLIT_NOT_APPLICABLE_REASON,
      );
    } else if (['load', 'epoch_publication', 'dispatch', 'retirement'].includes(phaseKey)) {
      recorder.notApplicable(
        phaseKey,
        ARBITRARY_COLD_BATCH_TIMING_RUNTIME_NOT_APPLICABLE_REASON,
      );
    } else {
      recorder.unavailable(phaseKey, unavailableReason);
    }
  }
  TIMING_RECORDER_SCOPES.set(recorder, scope);
  return recorder;
}

function assertOwnedTimingPhaseDisposition(testTiming, scope) {
  const unavailableReason = scope === 'batch'
    ? ARBITRARY_COLD_BATCH_TIMING_PHASE_UNAVAILABLE_REASON
    : scope === 'attempt'
      ? ARBITRARY_COLD_ATTEMPT_TIMING_PHASE_UNAVAILABLE_REASON
      : ARBITRARY_COLD_TOP_LEVEL_TIMING_PHASE_UNAVAILABLE_REASON;
  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    const phase = testTiming.phases?.[phaseKey];
    if (phaseKey === 'total_wall' || phaseKey === 'proof_finalization') {
      if (phase?.state !== 'measured') {
        throw new Error('arbitrary_cold_batch_timing_phase_invalid');
      }
    } else if (scope === 'batch' && phaseKey === 'discovery') {
      if (phase?.state !== 'measured') {
        throw new Error('arbitrary_cold_batch_timing_phase_invalid');
      }
    } else if (GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.includes(phaseKey)) {
      if (
        phase?.state !== 'not_applicable'
        || phase.reasonCode !== ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON
      ) {
        throw new Error('arbitrary_cold_batch_timing_phase_invalid');
      }
    } else if (phaseKey === 'split') {
      if (
        phase?.state !== 'not_applicable'
        || phase.reasonCode !== ARBITRARY_COLD_BATCH_TIMING_SPLIT_NOT_APPLICABLE_REASON
      ) {
        throw new Error('arbitrary_cold_batch_timing_phase_invalid');
      }
    } else if (['load', 'epoch_publication', 'dispatch', 'retirement'].includes(phaseKey)) {
      if (
        phase?.state !== 'not_applicable'
        || phase.reasonCode !== ARBITRARY_COLD_BATCH_TIMING_RUNTIME_NOT_APPLICABLE_REASON
      ) {
        throw new Error('arbitrary_cold_batch_timing_phase_invalid');
      }
    } else if (phase?.state !== 'unavailable' || phase.reasonCode !== unavailableReason) {
      throw new Error('arbitrary_cold_batch_timing_phase_invalid');
    }
  }
  return testTiming;
}

function terminalSnapshot({ scope, terminalOutcome, descriptorHash = null, payload }) {
  return {
    schemaVersion: ARBITRARY_COLD_BATCH_TERMINAL_SNAPSHOT_SCHEMA,
    proofAuthority: ARBITRARY_COLD_BATCH_TERMINAL_SNAPSHOT_AUTHORITY,
    scope,
    terminalOutcome,
    descriptorHash,
    payload,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
}

async function finalizeTimingAfterTerminalPersistence({
  recorder,
  terminalOutcome,
  persistTerminalSnapshot,
  snapshot,
}) {
  const scope = TIMING_RECORDER_SCOPES.get(recorder);
  if (!scope || recorder.isFinalized || typeof persistTerminalSnapshot !== 'function') {
    throw new Error('arbitrary_cold_batch_timing_finalization_invalid');
  }
  recorder.startPhase('proof_finalization');
  let resolvedTerminalOutcome = terminalOutcome;
  let persistenceError = null;
  try {
    await persistTerminalSnapshot(snapshot);
  } catch (error) {
    persistenceError = error;
    resolvedTerminalOutcome = 'failed';
  } finally {
    recorder.finishPhase('proof_finalization');
  }
  const testTiming = recorder.finalize({
    outcome: timingOutcomeForTerminal(resolvedTerminalOutcome),
    visualCapable: false,
    terminalReason: terminalReasonForOutcome(resolvedTerminalOutcome, scope),
    notApplicableReason: ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON,
  });
  assertSupportOnlyTiming(testTiming, {
    expectedVisualReason: ARBITRARY_COLD_BATCH_TIMING_VISUAL_NOT_APPLICABLE_REASON,
  });
  assertOwnedTimingPhaseDisposition(testTiming, scope);
  return { testTiming, terminalOutcome: resolvedTerminalOutcome, persistenceError };
}

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPORT_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'selection',
  'summary',
  'reports',
  'acceptedAsColdBuildEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
]);
const REPORT_ENTRY_KEYS = Object.freeze([
  'descriptorHash',
  'descriptorBytesHash',
  'outcome',
  'runEvidence',
  'retainedExecutionChain',
  'artifactSessionRoot',
  'outputs',
  'failureEvidence',
]);

function parseCliArguments(argv) {
  if (argv.length % 2 !== 0) {
    throw new Error('arbitrary_cold_batch_cli_arguments_invalid');
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !CLI_KEYS.has(name)
      || typeof value !== 'string'
      || value.length < 1
      || Object.hasOwn(values, name)
    ) {
      throw new Error('arbitrary_cold_batch_cli_arguments_invalid');
    }
    values[name] = value;
  }
  if (!values['--artifact-root'] || !values['--descriptor-root'] || !values['--seed']) {
    throw new Error('arbitrary_cold_batch_cli_arguments_invalid');
  }
  const sampleCount = Number(values['--sample-count'] ?? 1);
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) {
    throw new Error('arbitrary_cold_batch_cli_sample_count_invalid');
  }
  return {
    artifactRoot: path.resolve(values['--artifact-root']),
    descriptorRoot: path.resolve(values['--descriptor-root']),
    dockerExecutable: values['--docker'] ?? 'docker',
    sampleCount,
    seed: values['--seed'],
  };
}

function serializedOutputs(result) {
  return result.outputs.map((output) => ({
    metadata: output.metadata,
    artifactLocator: output.artifactLocator,
    transportEvidence: output.transportEvidence,
  }));
}

function childTestTiming(source) {
  const record = timingAlias(source, 'testTiming', 'test_timing', { required: false });
  if (record !== null) assertSupportOnlyTiming(record);
  return record;
}

function terminalOutcomeForFailure(error, failure, timing) {
  if (timing?.outcome === 'refused') return 'refused';
  if (timing?.outcome === 'failed') return 'failed';
  const explicit = String(
    error?.timingOutcome
      ?? error?.terminalOutcome
      ?? error?.terminal_outcome
      ?? '',
  ).toLowerCase();
  if (explicit === 'refused' || explicit === 'failed') return explicit;
  if (
    failure?.readyRefusalEvidence
    || failure?.refusalDiagnostics
    || failure?.launcherDiagnostics
    || /(?:_invalid|_refused|_unsupported|_not_found)$/.test(failure?.failureCode ?? '')
  ) {
    return 'refused';
  }
  return 'failed';
}

function canonicalBatchReportProjection(report) {
  const projection = { ...report };
  for (const key of TIMING_TRANSPORT_KEYS) delete projection[key];
  if (report?.summary && typeof report.summary === 'object') {
    projection.summary = canonicalBatchSummaryProjection(report.summary);
  }
  if (Array.isArray(report?.reports)) {
    projection.reports = report.reports.map((entry) => {
      const canonicalEntry = { ...entry };
      for (const key of TIMING_TRANSPORT_KEYS) delete canonicalEntry[key];
      return canonicalEntry;
    });
  }
  delete projection.evidenceHash;
  return projection;
}

function canonicalBatchSummaryProjection(summary) {
  const projection = { ...summary };
  if (Array.isArray(summary?.attempts)) {
    projection.attempts = summary.attempts.map((attempt) => {
      const canonicalAttempt = { ...attempt };
      for (const key of TIMING_TRANSPORT_KEYS) delete canonicalAttempt[key];
      return canonicalAttempt;
    });
  }
  return projection;
}

function batchReportEvidenceHash(report) {
  return contentHash(stableJson(canonicalBatchReportProjection(report)));
}

export async function runArbitraryColdProjectBatch({
  artifactRoot,
  descriptorRoot,
  dockerExecutable = 'docker',
  sampleCount,
  seed,
  limits = {},
  runnerPolicy = {},
  timingClock = null,
  persistTerminalSnapshot = async () => {},
  runProject = runArbitraryColdProject,
} = {}) {
  if (
    (timingClock !== null && typeof timingClock !== 'function')
    || typeof persistTerminalSnapshot !== 'function'
    || typeof runProject !== 'function'
  ) {
    throw new TypeError('arbitrary_cold_batch_runtime_options_invalid');
  }
  const timingRecorder = (scope) => createArbitraryColdProjectBatchTimingRecorder({
    ...(timingClock === null ? {} : { clock: timingClock }),
    scope,
  });
  const batchTimingRecorder = timingRecorder('batch');
  batchTimingRecorder.startPhase('discovery');
  let records;
  let selection;
  try {
    records = await discoverArbitraryColdProjectDescriptors(descriptorRoot, {
      limits,
      runnerPolicy,
    });
    selection = selectArbitraryColdProjectDescriptors(records, { seed, sampleCount });
    verifyArbitraryColdBatchSelection(selection, records);
  } finally {
    batchTimingRecorder.finishPhase('discovery');
  }
  const recordsByHash = new Map(records.map((record) => [record.descriptorHash, record]));
  const attempts = [];
  const reports = [];
  for (const selected of selection.selected) {
    const record = recordsByHash.get(selected.descriptorHash);
    const attemptTimingRecorder = timingRecorder('attempt');
    let attempt;
    let reportEntry;
    let terminalOutcome;
    let retainedChildTiming = null;
    try {
      const result = await runProject(record.descriptor, {
        artifactRoot,
        dockerExecutable,
        policy: runnerPolicy,
        ...(timingClock === null ? {} : { timingClock }),
      });
      await verifyArbitraryColdProjectRun(result);
      retainedChildTiming = childTestTiming(result);
      if (retainedChildTiming !== null && retainedChildTiming.outcome !== 'pass') {
        throw new Error('arbitrary_cold_batch_completed_child_timing_invalid');
      }
      attempt = await createCompletedArbitraryColdBatchAttempt({
        selection,
        records,
        descriptorHash: record.descriptorHash,
        result,
      });
      reportEntry = {
        descriptorHash: record.descriptorHash,
        descriptorBytesHash: record.descriptorBytesHash,
        outcome: 'cold_run_completed',
        runEvidence: result.evidence,
        retainedExecutionChain: result.retainedExecutionChain,
        artifactSessionRoot: result.artifactSessionRoot,
        outputs: serializedOutputs(result),
        failureEvidence: null,
      };
      terminalOutcome = 'completed';
    } catch (error) {
      const failure = createArbitraryColdProjectRunFailure(error, {
        ...(timingClock === null ? {} : { timingClock }),
      });
      verifyArbitraryColdProjectRunFailure(failure);
      retainedChildTiming = childTestTiming(failure);
      terminalOutcome = terminalOutcomeForFailure(error, failure, retainedChildTiming);
      attempt = createRefusedArbitraryColdBatchAttempt({
        selection,
        records,
        descriptorHash: record.descriptorHash,
        failure,
      });
      reportEntry = {
        descriptorHash: record.descriptorHash,
        descriptorBytesHash: record.descriptorBytesHash,
        outcome: 'cold_run_refused',
        runEvidence: null,
        retainedExecutionChain: null,
        artifactSessionRoot: null,
        outputs: [],
        failureEvidence: failure,
      };
    }
    const attemptSnapshotPayload = structuredClone(reportEntry);
    if (retainedChildTiming !== null) {
      const serializedChildTiming = structuredClone(retainedChildTiming);
      attemptSnapshotPayload.childTestTiming = serializedChildTiming;
      attemptSnapshotPayload.child_test_timing = serializedChildTiming;
    }
    const finalizedAttempt = await finalizeTimingAfterTerminalPersistence({
      recorder: attemptTimingRecorder,
      terminalOutcome,
      persistTerminalSnapshot,
      snapshot: terminalSnapshot({
        scope: 'attempt',
        terminalOutcome,
        descriptorHash: record.descriptorHash,
        payload: attemptSnapshotPayload,
      }),
    });
    attachArbitraryColdProjectBatchTestTiming(
      reportEntry,
      finalizedAttempt.testTiming,
      {
        terminalOutcome: finalizedAttempt.terminalOutcome,
        childTestTiming: retainedChildTiming,
      },
    );
    attempts.push(attempt);
    reports.push(reportEntry);
  }
  const summary = createArbitraryColdBatchSummary(selection, records, attempts);
  summary.attempts.forEach((summaryAttempt, index) => {
    const reportEntry = reports[index];
    attachArbitraryColdProjectBatchTestTiming(summaryAttempt, reportEntry.testTiming, {
      terminalOutcome: reportEntry.terminalOutcome,
      childTestTiming: reportEntry.childTestTiming,
    });
  });
  const report = {
    schemaVersion: ARBITRARY_COLD_BATCH_REPORT_SCHEMA,
    proofAuthority: ARBITRARY_COLD_BATCH_REPORT_AUTHORITY,
    selection,
    summary,
    reports,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  report.evidenceHash = batchReportEvidenceHash(report);
  const attemptTerminalOutcomes = reports.map((entry) => entry.terminalOutcome);
  const batchTerminalOutcome = attemptTerminalOutcomes.includes('failed')
    ? 'failed'
    : attemptTerminalOutcomes.includes('refused')
      ? 'refused'
      : 'completed';
  const finalizedBatch = await finalizeTimingAfterTerminalPersistence({
    recorder: batchTimingRecorder,
    terminalOutcome: batchTerminalOutcome,
    persistTerminalSnapshot,
    snapshot: terminalSnapshot({
      scope: 'batch',
      terminalOutcome: batchTerminalOutcome,
      payload: JSON.parse(JSON.stringify(report)),
    }),
  });
  attachArbitraryColdProjectBatchTestTiming(report, finalizedBatch.testTiming, {
    terminalOutcome: finalizedBatch.terminalOutcome,
  });
  verifyArbitraryColdProjectBatchReport(report);
  return report;
}

export function verifyArbitraryColdProjectBatchReport(report) {
  const attempts = report?.summary?.attempts;
  const entryTiming = new Map();
  let reportTiming;
  try {
    reportTiming = verifyTimingTransport(report, {
      allowedTerminalOutcomes: ['completed', 'refused', 'failed'],
    });
    assertOwnedTimingPhaseDisposition(reportTiming.testTiming, 'batch');
    verifyRetainedArbitraryColdBatchSelection(report?.selection);
    verifyRetainedArbitraryColdBatchSummary(
      canonicalBatchSummaryProjection(report?.summary),
      report?.selection,
    );
    for (const [index, entry] of (report?.reports ?? []).entries()) {
      const timing = verifyTimingTransport(entry, {
        allowedTerminalOutcomes: entry?.outcome === 'cold_run_completed'
          ? ['completed', 'failed']
          : ['refused', 'failed'],
        childTimingRequired: true,
      });
      assertOwnedTimingPhaseDisposition(timing.testTiming, 'attempt');
      const summaryTiming = verifyTimingTransport(attempts?.[index], {
        allowedTerminalOutcomes: entry?.outcome === 'cold_run_completed'
          ? ['completed', 'failed']
          : ['refused', 'failed'],
        childTimingRequired: true,
      });
      assertOwnedTimingPhaseDisposition(summaryTiming.testTiming, 'attempt');
      if (
        stableJson(summaryTiming.testTiming) !== stableJson(timing.testTiming)
        || summaryTiming.terminalOutcome !== timing.terminalOutcome
        || stableJson(summaryTiming.childTestTiming) !== stableJson(timing.childTestTiming)
      ) {
        throw new Error('summary attempt timing did not preserve report timing');
      }
      entryTiming.set(entry, timing);
      if (entry?.outcome === 'cold_run_completed') {
        if (timing.childTestTiming.outcome !== 'pass') {
          throw new Error('completed child timing did not pass');
        }
        verifyArbitraryColdRetainedExecutionChain(entry.retainedExecutionChain);
        createArbitraryColdCliResultEnvelope({
          descriptorBytesHash: entry.descriptorBytesHash,
          result: {
            evidence: entry.runEvidence,
            retainedExecutionChain: entry.retainedExecutionChain,
            outputs: entry.outputs,
          },
        });
      } else if (entry?.outcome === 'cold_run_refused') {
        verifyArbitraryColdProjectRunFailure(entry.failureEvidence);
        if (
          !['refused', 'failed'].includes(timing.childTestTiming.outcome)
          || stableJson(timing.childTestTiming)
            !== stableJson(entry.failureEvidence.testTiming)
          || stableJson(timing.childTestTiming)
            !== stableJson(entry.failureEvidence.test_timing)
        ) {
          throw new Error('refused child timing was not preserved');
        }
      }
    }
  } catch {
    throw new Error('arbitrary_cold_batch_report_invalid');
  }
  const expectedBatchTerminalOutcome = report.reports.some(
    (entry) => entryTiming.get(entry)?.terminalOutcome === 'failed',
  )
    ? 'failed'
    : report.reports.some((entry) => entryTiming.get(entry)?.terminalOutcome === 'refused')
      ? 'refused'
      : 'completed';
  if (
    !exactCanonicalKeys(report, REPORT_KEYS)
    || report?.schemaVersion !== ARBITRARY_COLD_BATCH_REPORT_SCHEMA
    || report?.proofAuthority !== ARBITRARY_COLD_BATCH_REPORT_AUTHORITY
    || !Array.isArray(report?.reports)
    || !Array.isArray(attempts)
    || report.reports.length !== attempts.length
    || report.reports.some((entry, index) => (
      !exactCanonicalKeys(entry, REPORT_ENTRY_KEYS)
      || !HASH_PATTERN.test(entry?.descriptorHash ?? '')
      || !HASH_PATTERN.test(entry?.descriptorBytesHash ?? '')
      || entry?.descriptorHash !== attempts[index]?.descriptorHash
      || !['cold_run_completed', 'cold_run_refused'].includes(entry?.outcome)
      || entry?.outcome !== attempts[index]?.outcome
      || (entry.outcome === 'cold_run_completed' && (
        entry?.runEvidence?.evidenceHash !== attempts[index].runEvidenceHash
        || entry?.runEvidence?.descriptorHash !== entry.descriptorHash
        || entry?.retainedExecutionChain?.descriptorHash !== entry.descriptorHash
        || entry?.retainedExecutionChain?.evidenceHash
          !== attempts[index].retainedExecutionChainHash
        || !HASH_PATTERN.test(attempts[index].retainedExecutionChainHash ?? '')
        || stableJson(entry?.retainedExecutionChain?.runEvidence)
          !== stableJson(entry?.runEvidence)
        || entry?.runEvidence?.acceptedAsColdBuildEvidence !== true
        || entry?.runEvidence?.acceptedForGpuHmr !== false
        || entry?.runEvidence?.gpuHmrSuccess !== false
        || entry?.runEvidence?.canSatisfyRuntimeProof !== false
        || entry?.runEvidence?.canSatisfyDispatchProof !== false
        || entry?.failureEvidence !== null
        || typeof entry?.artifactSessionRoot !== 'string'
        || entry.artifactSessionRoot.length < 1
        || !Array.isArray(entry?.outputs)
        || entry.outputs.length !== attempts[index].artifactCount
      ))
      || (entry.outcome === 'cold_run_refused' && (
        entry?.failureEvidence?.evidenceHash !== attempts[index].failureEvidenceHash
        || attempts[index].retainedExecutionChainHash !== null
        || entry?.failureEvidence?.acceptedAsColdBuildEvidence !== false
        || entry?.failureEvidence?.acceptedForGpuHmr !== false
        || entry?.failureEvidence?.gpuHmrSuccess !== false
        || entry?.failureEvidence?.canSatisfyRuntimeProof !== false
        || entry?.failureEvidence?.canSatisfyDispatchProof !== false
        || entry?.runEvidence !== null
        || entry?.retainedExecutionChain !== null
        || entry?.artifactSessionRoot !== null
        || !Array.isArray(entry?.outputs)
        || entry.outputs.length !== 0
      ))
    ))
    || report?.summary?.acceptedAsColdBuildEvidence !== false
    || report?.summary?.acceptedForGpuHmr !== false
    || report?.summary?.gpuHmrSuccess !== false
    || report?.selection?.acceptedAsColdBuildEvidence !== false
    || report?.selection?.acceptedForGpuHmr !== false
    || report?.selection?.gpuHmrSuccess !== false
    || report?.acceptedAsColdBuildEvidence !== false
    || report?.acceptedForGpuHmr !== false
    || report?.gpuHmrSuccess !== false
    || report?.canSatisfyRuntimeProof !== false
    || report?.canSatisfyDispatchProof !== false
    || (
      reportTiming.terminalOutcome !== expectedBatchTerminalOutcome
      && reportTiming.terminalOutcome !== 'failed'
    )
    || batchReportEvidenceHash(report) !== report?.evidenceHash
  ) {
    throw new Error('arbitrary_cold_batch_report_invalid');
  }
  return report;
}

function batchFailureCode(error) {
  const candidate = String(error?.message ?? '');
  return /^[a-z0-9][a-z0-9_.:-]{0,255}$/.test(candidate)
    ? candidate
    : 'arbitrary_cold_batch_failed';
}

function topLevelTerminalOutcome(error) {
  const code = batchFailureCode(error);
  return /(?:_invalid|_refused|_unsupported|_not_found)$/.test(code)
    ? 'refused'
    : 'failed';
}

const BATCH_FAILURE_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'failureCode',
  'acceptedAsColdBuildEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
]);

export async function createArbitraryColdProjectBatchFailure(error, {
  timingClock = null,
  timingRecorder = null,
  persistTerminalSnapshot = async () => {},
} = {}) {
  if (
    (timingClock !== null && typeof timingClock !== 'function')
    || typeof persistTerminalSnapshot !== 'function'
  ) {
    throw new TypeError('arbitrary_cold_batch_failure_options_invalid');
  }
  const recorder = timingRecorder ?? createArbitraryColdProjectBatchTimingRecorder({
    ...(timingClock === null ? {} : { clock: timingClock }),
    scope: 'top_level',
  });
  if (TIMING_RECORDER_SCOPES.get(recorder) !== 'top_level') {
    throw new TypeError('arbitrary_cold_batch_failure_timing_recorder_invalid');
  }
  const failure = {
    schemaVersion: ARBITRARY_COLD_BATCH_FAILURE_SCHEMA,
    proofAuthority: ARBITRARY_COLD_BATCH_FAILURE_AUTHORITY,
    failureCode: batchFailureCode(error),
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  failure.evidenceHash = contentHash(stableJson(failure));
  const initialTerminalOutcome = topLevelTerminalOutcome(error);
  const finalized = await finalizeTimingAfterTerminalPersistence({
    recorder,
    terminalOutcome: initialTerminalOutcome,
    persistTerminalSnapshot,
    snapshot: terminalSnapshot({
      scope: 'top_level',
      terminalOutcome: initialTerminalOutcome,
      payload: structuredClone(failure),
    }),
  });
  attachArbitraryColdProjectBatchTestTiming(failure, finalized.testTiming, {
    terminalOutcome: finalized.terminalOutcome,
  });
  verifyArbitraryColdProjectBatchFailure(failure);
  return failure;
}

export function verifyArbitraryColdProjectBatchFailure(failure) {
  let timing;
  try {
    timing = verifyTimingTransport(failure, {
      allowedTerminalOutcomes: ['refused', 'failed'],
    });
    assertOwnedTimingPhaseDisposition(timing.testTiming, 'top_level');
  } catch {
    throw new Error('arbitrary_cold_batch_failure_invalid');
  }
  const projection = { ...failure };
  for (const key of TIMING_TRANSPORT_KEYS) delete projection[key];
  delete projection.evidenceHash;
  if (
    !exactCanonicalKeys(failure, BATCH_FAILURE_KEYS)
    || failure.schemaVersion !== ARBITRARY_COLD_BATCH_FAILURE_SCHEMA
    || failure.proofAuthority !== ARBITRARY_COLD_BATCH_FAILURE_AUTHORITY
    || !/^[a-z0-9][a-z0-9_.:-]{0,255}$/.test(failure.failureCode ?? '')
    || failure.acceptedAsColdBuildEvidence !== false
    || failure.acceptedForGpuHmr !== false
    || failure.gpuHmrSuccess !== false
    || failure.canSatisfyRuntimeProof !== false
    || failure.canSatisfyDispatchProof !== false
    || contentHash(stableJson(projection)) !== failure.evidenceHash
  ) {
    throw new Error('arbitrary_cold_batch_failure_invalid');
  }
  return failure;
}

function writeJsonLine(stream, value) {
  return new Promise((resolve, reject) => {
    stream.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  const result = await runArbitraryColdProjectBatch({
    ...options,
    persistTerminalSnapshot: (snapshot) => writeJsonLine(process.stderr, snapshot),
  });
  verifyArbitraryColdProjectBatchReport(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.terminalOutcome !== 'completed') process.exitCode = 1;
}

const directInvocation = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directInvocation) {
  const topLevelTimingRecorder = createArbitraryColdProjectBatchTimingRecorder({
    scope: 'top_level',
  });
  try {
    await main();
  } catch (error) {
    const failure = await createArbitraryColdProjectBatchFailure(error, {
      timingRecorder: topLevelTimingRecorder,
      persistTerminalSnapshot: (snapshot) => writeJsonLine(process.stderr, snapshot),
    });
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  }
}
