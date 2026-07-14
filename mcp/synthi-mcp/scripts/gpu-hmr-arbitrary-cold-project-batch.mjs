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
} from './lib/gpu-hmr-arbitrary-cold-project-batch.mjs';
import {
  createArbitraryColdCliResultEnvelope,
} from './lib/gpu-hmr-arbitrary-cold-cli-envelope.mjs';
import {
  verifyArbitraryColdRetainedExecutionChain,
} from './lib/gpu-hmr-arbitrary-cold-retained-chain.mjs';

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

export async function runArbitraryColdProjectBatch({
  artifactRoot,
  descriptorRoot,
  dockerExecutable = 'docker',
  sampleCount,
  seed,
  limits = {},
  runnerPolicy = {},
} = {}) {
  const records = await discoverArbitraryColdProjectDescriptors(descriptorRoot, {
    limits,
    runnerPolicy,
  });
  const selection = selectArbitraryColdProjectDescriptors(records, { seed, sampleCount });
  verifyArbitraryColdBatchSelection(selection, records);
  const recordsByHash = new Map(records.map((record) => [record.descriptorHash, record]));
  const attempts = [];
  const reports = [];
  for (const selected of selection.selected) {
    const record = recordsByHash.get(selected.descriptorHash);
    try {
      const result = await runArbitraryColdProject(record.descriptor, {
        artifactRoot,
        dockerExecutable,
        policy: runnerPolicy,
      });
      await verifyArbitraryColdProjectRun(result);
      attempts.push(await createCompletedArbitraryColdBatchAttempt({
        selection,
        records,
        descriptorHash: record.descriptorHash,
        result,
      }));
      reports.push({
        descriptorHash: record.descriptorHash,
        descriptorBytesHash: record.descriptorBytesHash,
        outcome: 'cold_run_completed',
        runEvidence: result.evidence,
        retainedExecutionChain: result.retainedExecutionChain,
        artifactSessionRoot: result.artifactSessionRoot,
        outputs: serializedOutputs(result),
        failureEvidence: null,
      });
    } catch (error) {
      const failure = createArbitraryColdProjectRunFailure(error);
      verifyArbitraryColdProjectRunFailure(failure);
      attempts.push(createRefusedArbitraryColdBatchAttempt({
        selection,
        records,
        descriptorHash: record.descriptorHash,
        failure,
      }));
      reports.push({
        descriptorHash: record.descriptorHash,
        descriptorBytesHash: record.descriptorBytesHash,
        outcome: 'cold_run_refused',
        runEvidence: null,
        retainedExecutionChain: null,
        artifactSessionRoot: null,
        outputs: [],
        failureEvidence: failure,
      });
    }
  }
  const summary = createArbitraryColdBatchSummary(selection, records, attempts);
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
  report.evidenceHash = contentHash(stableJson(report));
  verifyArbitraryColdProjectBatchReport(report);
  return report;
}

export function verifyArbitraryColdProjectBatchReport(report) {
  const projection = { ...report };
  delete projection.evidenceHash;
  const attempts = report?.summary?.attempts;
  try {
    for (const entry of report?.reports ?? []) {
      if (entry?.outcome === 'cold_run_completed') {
        verifyArbitraryColdRetainedExecutionChain(entry.retainedExecutionChain);
        createArbitraryColdCliResultEnvelope({
          descriptorBytesHash: entry.descriptorBytesHash,
          result: {
            evidence: entry.runEvidence,
            retainedExecutionChain: entry.retainedExecutionChain,
            outputs: entry.outputs,
          },
        });
      }
    }
  } catch {
    throw new Error('arbitrary_cold_batch_report_invalid');
  }
  if (
    !exactKeys(report, REPORT_KEYS)
    || report?.schemaVersion !== ARBITRARY_COLD_BATCH_REPORT_SCHEMA
    || report?.proofAuthority !== ARBITRARY_COLD_BATCH_REPORT_AUTHORITY
    || !Array.isArray(report?.reports)
    || !Array.isArray(attempts)
    || report.reports.length !== attempts.length
    || report.reports.some((entry, index) => (
      !exactKeys(entry, REPORT_ENTRY_KEYS)
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
    || contentHash(stableJson(projection)) !== report?.evidenceHash
  ) {
    throw new Error('arbitrary_cold_batch_report_invalid');
  }
  return report;
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  const result = await runArbitraryColdProjectBatch(options);
  verifyArbitraryColdProjectBatchReport(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.summary.refusedColdRunCount > 0) process.exitCode = 1;
}

const directInvocation = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directInvocation) {
  try {
    await main();
  } catch (error) {
    const code = /^[a-z0-9][a-z0-9_.:-]{0,255}$/.test(String(error?.message ?? ''))
      ? String(error.message)
      : 'arbitrary_cold_batch_failed';
    const failure = {
      schemaVersion: 'synthi.gpu_hmr.arbitrary_cold_project_batch_failure.v1',
      proofAuthority: 'batch_failure_diagnostics_only_not_cold_build_or_gpu_hmr_success',
      failureCode: code,
      acceptedAsColdBuildEvidence: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      canSatisfyDispatchProof: false,
    };
    failure.evidenceHash = contentHash(stableJson(failure));
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  }
}
